import test from "node:test";
import assert from "node:assert/strict";
import { validateTranslatedChunk } from "../../scripts/i18n/run-translation.mjs";
import {
  assertCompleteProposal,
  validateSection,
} from "../../scripts/i18n/import-native-translation.mjs";

const SOURCE = [
  "## Web Cookie Providers (2)",
  "",
  "| ID    | Name  | Notes            |",
  "| ----- | ----- | ---------------- |",
  "| `a`   | A     | Paste the cookie |",
  "| `b`   | B     | Paste the token  |",
  "",
  "```bash",
  "npm run gen:provider-reference",
  "```",
].join("\n");

const GOOD = [
  "## Web-cookie-udbydere (2)",
  "",
  "| ID    | Navn  | Noter             |",
  "| ----- | ----- | ----------------- |",
  "| `a`   | A     | Indsæt cookien    |",
  "| `b`   | B     | Indsæt tokenet    |",
  "",
  "```bash",
  "npm run gen:provider-reference",
  "```",
].join("\n");

test("a faithful translation passes unchanged", () => {
  const r = validateTranslatedChunk(SOURCE, GOOD);
  assert.deepEqual(r.problems, []);
  assert.equal(r.text, GOOD);
});

test("strips a leaked <think> block (refresh-5: 41 mirrors shipped one)", () => {
  const leaked = [
    "<think>",
    "Right, so I've been tasked with translating a Markdown table. I'll keep the header.",
    "</think>",
    "",
    GOOD,
  ].join("\n");
  const r = validateTranslatedChunk(SOURCE, leaked);
  assert.deepEqual(r.problems, []);
  assert.equal(r.text, GOOD);
});

test("strips a <think> block leaked in the middle of the chunk", () => {
  const lines = GOOD.split("\n");
  const leaked = [
    ...lines.slice(0, 4),
    "",
    "<think>",
    "My plan became clear: translate the third column only.",
    "</think>",
    "",
    ...lines.slice(4),
  ].join("\n");
  const r = validateTranslatedChunk(SOURCE, leaked);
  assert.deepEqual(r.problems, []);
  assert.ok(!r.text.includes("think>"));
  assert.ok(!r.text.includes("My plan"));
});

test("unwraps a ```markdown fence around the whole answer", () => {
  const r = validateTranslatedChunk(SOURCE, "```markdown\n" + GOOD + "\n```");
  assert.deepEqual(r.problems, []);
  assert.equal(r.text, GOOD);
});

test("rejects dropped table rows (refresh-5: es PROVIDER_REFERENCE lost 23 rows)", () => {
  const dropped = GOOD.split("\n")
    .filter((l) => !l.startsWith("| `b`"))
    .join("\n");
  const r = validateTranslatedChunk(SOURCE, dropped);
  assert.equal(r.problems.length, 1);
  assert.match(r.problems[0], /table rows 3\/4/);
});

const NATIVE_SOURCE = [
  "## Candidate classification",
  "",
  "Read `requiredAccessTier` in [the catalog](https://example.test/models).",
  "- Admit only `SAFE` candidates.",
  "",
  "```bash",
  "npm run i18n:check",
  "```",
].join("\n");
const NATIVE_FRENCH = [
  "## Classification des candidats",
  "",
  "Lisez `requiredAccessTier` dans [le catalogue](https://example.test/models).",
  "- N'admettez que les candidats `SAFE`.",
  "",
  "```bash",
  "npm run i18n:check",
  "```",
].join("\n");

test("native import accepts translated prose with unchanged technical Markdown", () => {
  assert.doesNotThrow(() => validateSection(NATIVE_SOURCE, NATIVE_FRENCH, 1));
});

test("native import rejects changed URLs, code, and untranslated prose", () => {
  assert.throws(
    () => validateSection(NATIVE_SOURCE, NATIVE_FRENCH.replace("example.test", "other.test"), 1),
    /links differ|urls differ/
  );
  assert.throws(
    () => validateSection(NATIVE_SOURCE, NATIVE_FRENCH.replace("i18n:check", "i18n:run"), 1),
    /fences differ/
  );
  assert.throws(() => validateSection(NATIVE_SOURCE, NATIVE_SOURCE, 1), /untranslated/);
  assert.throws(() => validateSection(NATIVE_SOURCE, "## Classification des candidats", 1), /incomplete/);
  assert.throws(() => validateSection(NATIVE_SOURCE, `${NATIVE_FRENCH}\nTODO`, 1), /placeholder/);
});

test("native import requires every changed section and no extra section", () => {
  const plan = { translate: [1, 4] };
  assert.doesNotThrow(() => assertCompleteProposal(plan, { 1: "a", 4: "b" }));
  assert.throws(() => assertCompleteProposal(plan, { 1: "a" }), /exactly the changed sections/);
  assert.throws(
    () => assertCompleteProposal(plan, { 1: "a", 4: "b", 6: "c" }),
    /exactly the changed sections/
  );
});

test("rejects a changed code-fence count", () => {
  const r = validateTranslatedChunk(SOURCE, GOOD + "\n```\nstray\n```");
  assert.ok(r.problems.some((p) => /code fences 4\/2/.test(p)));
});

test("rejects an unterminated <think> block", () => {
  const r = validateTranslatedChunk(SOURCE, "<think>\nI need to translate this.\n" + GOOD);
  assert.ok(r.problems.some((p) => /think/.test(p)));
});

test("rejects English meta-prose that the source does not contain", () => {
  const leaked = "Okay, I need to translate the table below.\n\n" + GOOD;
  const r = validateTranslatedChunk(SOURCE, leaked);
  assert.ok(r.problems.some((p) => /meta-prose/.test(p)));
});

test("meta phrases already present in the source are not flagged", () => {
  const src = "I'll show the steps below.\n\n" + SOURCE;
  const out = "I'll show the steps below.\n\n" + GOOD;
  assert.deepEqual(validateTranslatedChunk(src, out).problems, []);
});
