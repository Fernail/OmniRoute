/**
 * xKiro quota and model-tier snapshot for STRICT_ZERO_COST.
 *
 * `/v1/usage` reports account-level free-token headroom; `/v1/models` reports
 * each model's access tier. Both reads must succeed and validate before this
 * adapter returns a snapshot. Usage reads are free and unmetered per xKiro's
 * API documentation. No paid window or wallet field is used for admission.
 */
type AccessTier = "free" | "paid" | "premium";
type JsonRecord = Record<string, unknown>;
type FetchLike = typeof fetch;

const API_BASE = "https://api.xkiro.com/v1";
const VALID_ACCESS_TIERS = new Set<AccessTier>(["free", "paid", "premium"]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`xKiro usage response has invalid ${field}`);
  }
  return value;
}

async function readJson(response: Response, endpoint: string): Promise<unknown> {
  if (!response.ok) throw new Error(`xKiro ${endpoint} request failed (${response.status})`);
  try {
    return await response.json();
  } catch {
    throw new Error(`xKiro ${endpoint} response is not valid JSON`);
  }
}

function parseUsage(payload: unknown) {
  if (!isRecord(payload) || payload.object !== "usage" || !isRecord(payload.free_tokens)) {
    throw new Error("xKiro usage response is missing free-token quota data");
  }

  const limit = parseCount(payload.free_tokens.limit_per_day, "free_tokens.limit_per_day");
  const used = parseCount(payload.free_tokens.used_today, "free_tokens.used_today");
  const remaining = parseCount(payload.free_tokens.remaining, "free_tokens.remaining");
  if (limit === 0 || used > limit || remaining !== limit - used) {
    throw new Error("xKiro usage response has inconsistent free-token quota data");
  }

  return {
    used,
    total: limit,
    remaining,
    remainingPercentage: (100 * remaining) / limit,
    resetAt: null,
    unlimited: false,
    displayName: "Free tokens (daily)",
  };
}

function parseAccessTiers(payload: unknown): Record<string, AccessTier> {
  if (!isRecord(payload) || !Array.isArray(payload.data) || payload.data.length === 0) {
    throw new Error("xKiro model catalog is missing model access tiers");
  }

  const accessTiers: Record<string, AccessTier> = {};
  for (const entry of payload.data) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !entry.id.trim()) {
      throw new Error("xKiro model catalog contains an invalid model entry");
    }
    if (typeof entry.access_tier !== "string" || !VALID_ACCESS_TIERS.has(entry.access_tier as AccessTier)) {
      throw new Error("xKiro model catalog contains an invalid access_tier");
    }
    const id = entry.id.trim();
    const tier = entry.access_tier as AccessTier;
    const previous = accessTiers[id];
    if (previous && previous !== tier) {
      throw new Error("xKiro model catalog contains conflicting access tiers");
    }
    accessTiers[id] = tier;
  }
  return accessTiers;
}

/** Fetch the free quota and per-model access tiers using offline-injectable fetch. */
export async function getXkiroUsage(apiKey: string, options: { fetchImpl?: FetchLike } = {}) {
  if (!apiKey.trim()) throw new Error("xKiro API key is unavailable");
  const fetchImpl = options.fetchImpl ?? fetch;
  const usageResponse = await fetchImpl(`${API_BASE}/usage`, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  });
  const usage = parseUsage(await readJson(usageResponse, "usage"));

  // The model catalog is public. Do not attach the account credential to it.
  const modelsResponse = await fetchImpl(`${API_BASE}/models`, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  });
  const accessTiers = parseAccessTiers(await readJson(modelsResponse, "model catalog"));

  return {
    plan: "xKiro",
    quotas: { free_tokens: usage },
    accessTiers,
  };
}

export const __testing = { parseUsage, parseAccessTiers };
