/**
 * `extractRemainingAllowance` treats an all-unlimited quota as proven-safe headroom
 * only for providers with a documented free tier; anything else stays unknown.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  __testing,
  resolveFreeAccessState,
} from "../../open-sse/services/autoCombo/freeAccessQuota.ts";
import { invalidateConnectionUpdate } from "../../src/lib/db/readCache.ts";
import { createProviderConnection, updateProviderConnection } from "../../src/lib/db/providers.ts";

describe("extractRemainingAllowance unlimited gate", () => {
  it("reports full headroom for an all-unlimited free-tier quota", () => {
    const usage = { quotas: { a: { unlimited: true }, b: { unlimited: true } } };
    assert.equal(__testing.extractRemainingAllowance(usage, { isFreeTier: true }), 100);
  });

  it("stays unknown for an all-unlimited quota outside the free tier", () => {
    const usage = { quotas: { a: { unlimited: true } } };
    assert.equal(__testing.extractRemainingAllowance(usage, { isFreeTier: false }), null);
  });

  it("prefers the worst limited reading when unlimited and limited quotas mix", () => {
    const usage = { quotas: { a: { unlimited: true }, b: { remainingPercentage: 42 } } };
    assert.equal(__testing.extractRemainingAllowance(usage, { isFreeTier: true }), 42);
  });
});

describe("free access quota refresh invalidation fence", () => {
  for (const writePath of ["update", "dedup"] as const) {
    it(`drops cached SAFE after a real ${writePath} replaces an API key under the same ID`, async () => {
      const provider = "xkiro";
      const name = `xkiro-quota-${writePath}-test`;
      const initial = await createProviderConnection({
        provider, authType: "apikey", name, apiKey: "old-key",
      });
      const connectionId = String(initial?.id);
      const key = `${provider}::${connectionId}`;
      const originalUsage = __testing.quotaDependencies.getUsageForProvider;
      __testing.quotaDependencies.getUsageForProvider = async (connection) => ({
        quotas: {
          free_tokens: {
            remaining: (connection as { apiKey: string }).apiKey === "old-key" ? 80 : 0,
            total: 100,
          },
        },
      });

      try {
        assert.equal(resolveFreeAccessState(provider, connectionId), undefined);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(resolveFreeAccessState(provider, connectionId)?.status, "SAFE");

        await updateProviderConnection(connectionId, { lastError: "temporary" });
        assert.equal(resolveFreeAccessState(provider, connectionId)?.status, "SAFE");

        const updated = writePath === "update"
          ? await updateProviderConnection(connectionId, { apiKey: "new-key" })
          : await createProviderConnection({
              provider, authType: "apikey", name, apiKey: "new-key",
            });
        assert.equal(updated?.id, connectionId);
        assert.equal(resolveFreeAccessState(provider, connectionId), undefined);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(resolveFreeAccessState(provider, connectionId)?.status, "EXHAUSTED");
      } finally {
        __testing.quotaDependencies.getUsageForProvider = originalUsage;
        __testing.cache.delete(key);
      }
    });
  }

  it("does not restore SAFE when an in-flight refresh completes after invalidation", async () => {
    const key = "xkiro::xkiro-race-test-connection";
    const [provider, connectionId] = key.split("::");
    const originalConnections = __testing.quotaDependencies.getCachedProviderConnections;
    const originalUsage = __testing.quotaDependencies.getUsageForProvider;
    let resolveUsage!: (usage: unknown) => void;
    __testing.quotaDependencies.getCachedProviderConnections = async () => [
      { id: connectionId, provider },
    ];
    __testing.quotaDependencies.getUsageForProvider = () =>
      new Promise((resolve) => {
        resolveUsage = resolve;
      });

    try {
      assert.equal(resolveFreeAccessState(provider!, connectionId), undefined);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(__testing.inFlight.has(key), true);

      // Simulate an upstream auth/quota failure before the refresh response is
      // delivered. That response must not resurrect the old SAFE admission.
      invalidateConnectionUpdate(connectionId, { apiKey: "replacement-key" });
      resolveUsage!({
        quotas: { free_tokens: { remaining: 80, total: 100 } },
        accessTiers: { "qwen/qwen3-vl-plus:free": "free" },
      });
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(__testing.cache.has(key), false);
      assert.equal(resolveFreeAccessState(provider!, connectionId), undefined);
    } finally {
      __testing.quotaDependencies.getCachedProviderConnections = originalConnections;
      __testing.quotaDependencies.getUsageForProvider = originalUsage;
      __testing.cache.delete(key);
    }
  });
});
