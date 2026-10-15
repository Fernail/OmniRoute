#!/usr/bin/env node
// Experimental offline import. One reviewed source/locale proposal per invocation.
// This never calls a translation backend and never adopts an untranslated mirror.
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractMirrorBody,
  extractTopHeading,
  findSourceTextByHash,
  looksUntranslated,
  mergeStateUpdates,
  planSectionReuse,
  sectionHashes,
  splitSections,
  stripTopHeading,
  validateTranslatedChunk,
  writeStateAtomic,
} from "./run-translation.mjs";
import { buildMirrorBar } from "./lib/language-bar.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };

function sameItems(a, b) {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

function multisetDifference(left, right) {
  const remaining = [...right];
  return left.filter((item) => {
    const index = remaining.indexOf(item);
    if (index < 0) return true;
    remaining.splice(index, 1);
    return false;
  });
}

function findExactSourceAcrossRefs(rel, expectedHash) {
  const commits = execFileSync("git", ["log", "--all", "--format=%H", "--", rel], {
    cwd: ROOT, encoding: "utf8",
  }).trim().split("\n").filter(Boolean);
  for (const commit of commits) {
    try {
      const bytes = execFileSync("git", ["show", `${commit}:${rel}`], {
        cwd: ROOT, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"],
      });
      if (sha256(bytes) === expectedHash) return bytes.toString("utf8");
    } catch {
      // A commit in the path history may have deleted the source.
    }
  }
  return null;
}

function markdownTokens(text) {
  const lines = text.split("\n");
  const fences = [];
  const outside = [];
  let block = null;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (block) { block.push(line); fences.push(block.join("\n")); block = null; }
      else block = [line];
    } else if (block) block.push(line);
    else outside.push(line);
  }
  if (block) fail("unclosed Markdown fence");
  const prose = outside.join("\n");
  const inline = [...prose.matchAll(/(`+)([\s\S]*?)\1/g)].map((m) => m[0]);
  const links = [...prose.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
  const urls = [...prose.matchAll(/https?:\/\/[^\s)>\]]+/g)].map((m) => m[0]);
  const technical = [...prose.matchAll(/\b(?:[A-Z][A-Z0-9_]{2,}|[a-z]+[A-Z][A-Za-z0-9]*|[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+)\b|--[a-z][\w-]*/g)].map((m) => m[0]);
  const numbers = [...prose.matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]);
  const headings = outside.filter((l) => /^#{2,6} /.test(l)).map((l) => l.match(/^#+/)[0]);
  const listMarks = outside.filter((l) => /^\s*(?:[-*] |\d+\. )/.test(l)).map((l) => l.match(/^\s*(?:[-*]|\d+\.)/)[0].trim().replace(/^\d+\.$/, "#."));
  const tableColumns = outside.filter((l) => /^\s*\|/.test(l)).map((l) => (l.match(/\|/g) || []).length);
  return { fences, inline, links, urls, technical, numbers, headings, listMarks, tableColumns };
}

export function validateSection(source, translated, index) {
  if (typeof translated !== "string" || !translated.trim()) fail(`section ${index}: empty translation`);
  if (translated.includes("\r")) fail(`section ${index}: CRLF is unsupported`);
  if (source.length > 100 && translated.trim().length < source.trim().length * 0.3)
    fail(`section ${index}: incomplete translation (less than 30% of source length)`);
  const introducedPlaceholders = /\b(?:TODO|TBD|TRANSLATE ME)\b|\[translation (?:needed|pending)\]/i;
  if (introducedPlaceholders.test(translated) && !introducedPlaceholders.test(source))
    fail(`section ${index}: translation placeholder`);
  const checked = validateTranslatedChunk(source, translated);
  if (checked.problems.length || checked.text !== translated.trim())
    fail(`section ${index}: invalid translated chunk: ${checked.problems.join(", ") || "wrapper/meta text"}`);
  if (looksUntranslated(translated, source)) fail(`section ${index}: untranslated source prose`);
  const original = markdownTokens(source);
  const target = markdownTokens(translated);
  for (const field of Object.keys(original)) {
    const equal = field === "headings" || field === "listMarks" || field === "tableColumns"
      ? JSON.stringify(original[field]) === JSON.stringify(target[field])
      : sameItems(original[field], target[field]);
    if (!equal) {
      const missing = multisetDifference(original[field], target[field]);
      const added = multisetDifference(target[field], original[field]);
      fail(`section ${index}: ${field} differ from source (missing: ${missing.slice(0, 8).join(", ")}; added: ${added.slice(0, 8).join(", ")})`);
    }
  }
}

export function assertCompleteProposal(plan, suppliedSections) {
  if (!plan || !plan.translate.length) fail("section reuse plan unavailable or empty");
  const required = plan.translate.map(String).sort();
  const supplied = Object.keys(suppliedSections || {}).sort();
  if (JSON.stringify(required) !== JSON.stringify(supplied))
    fail(`proposal must contain exactly the changed sections: ${required.join(",")}`);
}

async function main() {
  const [proposalFile, option] = process.argv.slice(2);
  if (!proposalFile || ![undefined, "--check", "--apply"].includes(option))
    fail("usage: node scripts/i18n/import-native-translation.mjs <proposal.json> [--check|--apply]");
  const proposalText = await fs.readFile(proposalFile, "utf8");
  const proposal = JSON.parse(proposalText);
  const rel = proposal.source;
  if (typeof rel !== "string" || !/^docs\/(?!i18n\/)[A-Za-z0-9_./-]+\.md$/.test(rel)
      || rel.split("/").includes("..") || rel !== path.posix.normalize(rel)) fail("invalid source path");
  const config = JSON.parse(await fs.readFile(path.join(ROOT, "config/i18n.json"), "utf8"));
  const localeEntry = config.locales.find((item) => item.code === proposal.locale && item.code !== "en");
  if (!localeEntry) fail("locale is not configured");
  const sourcePath = path.join(ROOT, rel);
  const targetPath = path.join(ROOT, "docs/i18n", proposal.locale, rel);
  const statePath = path.join(ROOT, ".i18n-state.json");
  const [sourceBytes, mirrorBytes, stateBytes] = await Promise.all([
    fs.readFile(sourcePath), fs.readFile(targetPath), fs.readFile(statePath),
  ]);
  const sourceHash = sha256(sourceBytes);
  const sourceText = sourceBytes.toString("utf8");
  const mirrorText = mirrorBytes.toString("utf8");
  const state = JSON.parse(stateBytes.toString("utf8"));
  const prior = state.sources?.[rel]?.locales?.[proposal.locale];
  if (!prior?.source_hash || !prior?.target_hash) fail("existing locale state is required");
  if (proposal.source_sha256 !== sourceHash || proposal.previous_source_sha256 !== prior.source_hash)
    fail("proposal is stale relative to source or locale state");
  if (sha256(mirrorBytes) !== prior.target_hash) fail("mirror differs from recorded target hash");
  let previousSource = await findSourceTextByHash(rel, prior.source_hash, { cwd: ROOT });
  if (!previousSource) previousSource = findExactSourceAcrossRefs(rel, prior.source_hash);
  if (!previousSource) fail("previous source cannot be recovered from Git history");
  const sections = splitSections(stripTopHeading(sourceText));
  const mirrorSections = splitSections(extractMirrorBody(mirrorText));
  const previousHashes = prior.section_hashes ?? sectionHashes(splitSections(stripTopHeading(previousSource)));
  const plan = planSectionReuse({ previousHashes, sections, mirrorSections });
  assertCompleteProposal(plan, proposal.sections);
  const outputSections = [...sections];
  for (const [index, retained] of plan.reuse) outputSections[index] = retained;
  for (const index of plan.translate) {
    const translated = proposal.sections[index];
    validateSection(sections[index], translated, index);
    outputSections[index] = translated.trim();
  }
  const heading = extractTopHeading(sourceText) || path.basename(rel, ".md");
  const raw = `# ${heading} (${localeEntry.native})\n\n${buildMirrorBar(rel, proposal.locale, config)}\n\n---\n\n${outputSections.join("\n\n").trim()}\n`;
  const prettier = await import("prettier").catch(() => fail("prettier is required before import"));
  const formatted = await prettier.format(raw, { parser: "markdown", filepath: targetPath });
  const formattedSections = splitSections(extractMirrorBody(formatted));
  if (formattedSections.length !== sections.length) fail("formatter changed section count");
  for (const index of plan.translate) validateSection(sections[index], formattedSections[index], index);
  for (const [index, retained] of plan.reuse)
    if (formattedSections[index].trim() !== retained.trim()) fail(`formatter changed reused section ${index}`);
  console.log(`validated ${rel} -> ${proposal.locale}: ${plan.translate.length} translated, ${plan.reuse.size} reused`);
  if (option !== "--apply") return;
  if (sha256(await fs.readFile(sourcePath)) !== sourceHash || sha256(await fs.readFile(targetPath)) !== sha256(mirrorBytes)
      || sha256(await fs.readFile(statePath)) !== sha256(stateBytes)) fail("files changed during validation");
  const tempTarget = `${targetPath}.${process.pid}.tmp`;
  await fs.writeFile(tempTarget, formatted, "utf8");
  await fs.rename(tempTarget, targetPath);
  const targetHash = sha256(await fs.readFile(targetPath));
  const record = {
    source_hash: sourceHash,
    target_hash: targetHash,
    section_hashes: sectionHashes(sections),
    updated_at: new Date().toISOString(),
  };
  const fresh = JSON.parse(await fs.readFile(statePath, "utf8"));
  const merged = mergeStateUpdates(fresh, [{ rel, locale: proposal.locale, sourceHash, record }], state);
  await writeStateAtomic(statePath, merged);
  console.log(`imported ${rel} -> ${proposal.locale}; target hash ${targetHash}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
