import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { getUsageForProvider, USAGE_FETCHER_PROVIDERS } from "../../open-sse/services/usage.ts";
import { __testing, getXkiroUsage } from "../../open-sse/services/usage/xkiro.ts";

const KEY = "test-xkiro-key-never-log";
const usagePayload = {
  object: "usage",
  free_tokens: { used_today: 40, limit_per_day: 100, remaining: 60 },
  // Paid account windows and wallet balance do not grant strict free access.
  windows: [{ kind: "short", remaining_usd: "200.000000" }],
  wallet: { balance_usd: "200.000000" },
};
const modelPayload = {
  data: [
    { id: "model/free", access_tier: "free" },
    { id: "model/paid", access_tier: "paid" },
  ],
};

function response(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("xKiro strict-zero-cost quota adapter", () => {
  it("reads usage and model tiers; only sends the credential to the usage endpoint", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const usage = await getXkiroUsage(KEY, {
      fetchImpl: async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        requests.push({ url, authorization: headers.get("authorization") });
        return response(200, url.endsWith("/usage") ? usagePayload : modelPayload);
      },
    });

    assert.deepEqual(requests, [
      { url: "https://api.xkiro.com/v1/usage", authorization: `Bearer ${KEY}` },
      { url: "https://api.xkiro.com/v1/models", authorization: null },
    ]);
    assert.equal(usage.quotas.free_tokens.remaining, 60);
    assert.equal(usage.quotas.free_tokens.total, 100);
    assert.deepEqual(usage.accessTiers, { "model/free": "free", "model/paid": "paid" });
    assert.equal(JSON.stringify(usage).includes(KEY), false);
  });

  it("returns zero as exhausted quota without admitting paid windows or wallet", async () => {
    const usage = await getXkiroUsage(KEY, {
      fetchImpl: async (input) =>
        response(200, String(input).endsWith("/usage")
          ? { ...usagePayload, free_tokens: { used_today: 100, limit_per_day: 100, remaining: 0 } }
          : modelPayload),
    });
    assert.equal(usage.quotas.free_tokens.remaining, 0);
    assert.equal(usage.quotas.free_tokens.unlimited, false);
  });

  it("fails closed on 401, 403 and 429 from either provider endpoint", async () => {
    for (const status of [401, 403, 429]) {
      await assert.rejects(
        () => getXkiroUsage(KEY, { fetchImpl: async () => response(status, { secret: KEY }) }),
        new RegExp(`\\(${status}\\)`)
      );
      await assert.rejects(
        () => getXkiroUsage(KEY, {
          fetchImpl: async (input) =>
            response(String(input).endsWith("/usage") ? 200 : status,
              String(input).endsWith("/usage") ? usagePayload : { secret: KEY }),
        }),
        new RegExp(`\\(${status}\\)`)
      );
    }
  });

  it("rejects missing, invalid, inconsistent, or unbounded quota data", () => {
    for (const freeTokens of [
      undefined,
      { used_today: 0, limit_per_day: null, remaining: null },
      { used_today: -1, limit_per_day: 100, remaining: 101 },
      { used_today: 1.5, limit_per_day: 100, remaining: 98.5 },
      { used_today: 40, limit_per_day: 100, remaining: 61 },
      { used_today: 101, limit_per_day: 100, remaining: 0 },
      { used_today: 0, limit_per_day: 0, remaining: 0 },
    ]) {
      assert.throws(
        () => __testing.parseUsage({ object: "usage", free_tokens: freeTokens }),
        /xKiro usage response/
      );
    }
  });

  it("rejects malformed or unknown access_tier catalogs", () => {
    for (const data of [
      undefined,
      [],
      [{ id: "model/unknown" }],
      [{ id: "model/unknown", access_tier: "trial" }],
      [{ id: "model/unknown", access_tier: "free" }, { id: "model/unknown", access_tier: "paid" }],
    ]) {
      assert.throws(() => __testing.parseAccessTiers({ data }), /xKiro model catalog/);
    }
  });

  it("is registered and dispatched through the existing quota service", async () => {
    assert.ok(USAGE_FETCHER_PROVIDERS.includes("xkiro"));
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async (input) =>
        response(String(input).endsWith("/usage") ? 200 : 200,
          String(input).endsWith("/usage") ? usagePayload : modelPayload);
      const usage = await getUsageForProvider({ provider: "xkiro", apiKey: KEY });
      assert.equal(usage.quotas.free_tokens.remaining, 60);
      assert.equal(usage.accessTiers["model/free"], "free");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
