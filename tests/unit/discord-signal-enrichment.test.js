import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setupMockFs, seedMockFs, resetMockFs } from "../helpers/mock-fs.js";

vi.mock("dotenv/config", () => ({}));

/**
 * Unit tests for enrichDiscordSignalPoolData in tools/screening.js.
 *
 * Commit: 5bd2a2c — Enrich Discord signal pools with live Meteora data
 * when any critical screening field (volume, tvl, mcap, bin_step, holders,
 * organic_score) is missing/zero. Also overwrites stale 0 values.
 *
 * Strategy: Use mock-fs to control config.js (which reads user-config.json),
 * ensuring useDiscordSignals=true and screening defaults are set.
 * Mock globalThis.fetch to intercept all API calls:
 *   1. fetchPoolDiscoveryPage — returns regular pools (or empty)
 *   2. fetchDiscordSignalCandidates — returns Discord signal pools
 *   3. fetchPoolDiscoveryDetail — returns Meteora enrichment data
 */

// Set up mock fs BEFORE any config import
setupMockFs();
seedMockFs({
  "/test/user-config.json": JSON.stringify({
    screening: {
      useDiscordSignals: true,
    },
  }),
});

/** Extract pool address from Meteora Pool Discovery detail URL (filter_by is URL-encoded). */
function extractPoolAddressFromDiscoveryUrl(urlStr) {
  const filterMatch = urlStr.match(/filter_by=([^&]+)/);
  if (!filterMatch) return null;
  const filter = decodeURIComponent(filterMatch[1]);
  const poolMatch = filter.match(/pool_address=(.+)/);
  return poolMatch ? poolMatch[1] : null;
}

function isPoolDiscoveryDetailUrl(urlStr) {
  return urlStr.includes("pool-discovery-api.datapi.meteora.ag/pools") && urlStr.includes("page_size=1");
}

function makeDiscordSignalCandidate(overrides = {}) {
  return {
    discovery_pool: {
      name: "DOGE-SOL",
      pool_address: "DiscordPoolAddr1111111111111111111111111111",
      pool_type: "dlmm",
      volume: 0,
      tvl: null,
      active_tvl: null,
      fee: null,
      fee_active_tvl_ratio: null,
      volatility: null,
      base_token_holders: null,
      dlmm_params: null,
      token_x: { organic_score: null, market_cap: null, created_at: null },
      token_y: { organic_score: 70 },
      ...overrides,
    },
    source_count: 3,
    seen_count: 5,
    first_seen_at: "2026-05-20T10:00:00Z",
    last_seen_at: "2026-05-21T14:00:00Z",
  };
}

function makeMeteoraDetail(overrides = {}) {
  return {
    name: "DOGE-SOL",
    pool_address: "DiscordPoolAddr1111111111111111111111111111",
    volume: 50000,
    tvl: 100000,
    active_tvl: 90000,
    fee: 0.01,
    fee_active_tvl_ratio: 0.10,
    volatility: 12.5,
    base_token_holders: 500,
    dlmm_params: { bin_step: 100 },
    token_x: {
      organic_score: 80,
      market_cap: 500000,
      created_at: "2026-01-01T00:00:00Z",
      symbol: "DOGE",
    },
    token_y: { organic_score: 70 },
    ...overrides,
  };
}

function buildMockFetch({
  regularPools = [],
  discordCandidates = [],
  meteoraDetails = {},
} = {}) {
  return vi.fn(async (url) => {
    const urlStr = typeof url === "string" ? url : url.toString();

    if (urlStr.includes("/signals/discord/candidates")) {
      return { ok: true, json: async () => ({ candidates: discordCandidates }) };
    }

    if (isPoolDiscoveryDetailUrl(urlStr)) {
      const poolAddr = extractPoolAddressFromDiscoveryUrl(urlStr);
      const detail = poolAddr ? meteoraDetails[poolAddr] || null : null;
      return { ok: true, json: async () => ({ data: detail ? [detail] : [] }) };
    }

    if (urlStr.includes("pool-discovery-api.datapi.meteora.ag/pools") && urlStr.includes("filter_by=")) {
      return { ok: true, json: async () => ({ data: regularPools, total: regularPools.length }) };
    }

    return { ok: true, json: async () => ({ data: [] }) };
  });
}

/**
 * Count Meteora pool-detail fetches for enrichDiscordSignalPoolData only.
 * applyVolatilityTimeframe also uses page_size=1 with a longer timeframe (30m for 5m screening).
 */
function countEnrichmentCalls(fetchMock, screeningTimeframe = "5m") {
  return fetchMock.mock.calls.filter(([url]) => {
    const urlStr = typeof url === "string" ? url : url.toString();
    return (
      isPoolDiscoveryDetailUrl(urlStr) &&
      urlStr.includes(`timeframe=${screeningTimeframe}`)
    );
  }).length;
}

describe("enrichDiscordSignalPoolData", () => {
  let originalFetch;
  let originalEnv;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    originalEnv = { ...process.env };
    process.env.POOL_DISCOVERY_API_KEY = "test-key";

    // Force config to enable Discord signals
    const { config } = await import("../../config.js");
    config.screening.useDiscordSignals = true;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  // ────────────────────────────────────────────────
  // Core enrichment behavior
  // ────────────────────────────────────────────────

  it("calls enrichment for Discord pools with volume=0", async () => {
    const candidate = makeDiscordSignalCandidate();
    const poolAddr = candidate.discovery_pool.pool_address;

    globalThis.fetch = buildMockFetch({
      discordCandidates: [candidate],
      meteoraDetails: { [poolAddr]: makeMeteoraDetail() },
    });

    const { discoverPools } = await import("../../tools/screening.js");
    await discoverPools({ page_size: 5 });

    expect(countEnrichmentCalls(globalThis.fetch)).toBe(1);
  });

  it("skips enrichment for Discord pools that already have all critical fields", async () => {
    const candidate = makeDiscordSignalCandidate();
    candidate.discovery_pool.volume = 12000;
    candidate.discovery_pool.tvl = 50000;
    candidate.discovery_pool.base_token_holders = 500;
    candidate.discovery_pool.dlmm_params = { bin_step: 100 };
    candidate.discovery_pool.token_x = {
      organic_score: 80,
      market_cap: 500000,
      created_at: "2026-01-01T00:00:00Z",
    };

    globalThis.fetch = buildMockFetch({ discordCandidates: [candidate] });

    const { discoverPools } = await import("../../tools/screening.js");
    await discoverPools({ page_size: 5 });

    expect(countEnrichmentCalls(globalThis.fetch)).toBe(0);
  });

  it("triggers enrichment when mcap=0 even if volume > 0", async () => {
    const candidate = makeDiscordSignalCandidate();
    candidate.discovery_pool.volume = 12000;
    candidate.discovery_pool.tvl = 50000;
    candidate.discovery_pool.base_token_holders = 500;
    candidate.discovery_pool.dlmm_params = { bin_step: 100 };
    candidate.discovery_pool.token_x = {
      organic_score: 80,
      market_cap: 0,  // stale snapshot
      created_at: "2026-01-01T00:00:00Z",
    };
    const poolAddr = candidate.discovery_pool.pool_address;

    globalThis.fetch = buildMockFetch({
      discordCandidates: [candidate],
      meteoraDetails: { [poolAddr]: makeMeteoraDetail({ token_x: { market_cap: 500000 } }) },
    });

    const { discoverPools } = await import("../../tools/screening.js");
    await discoverPools({ page_size: 5 });

    expect(countEnrichmentCalls(globalThis.fetch)).toBe(1);
  });

  it("skips enrichment for non-Discord signal pools", async () => {
    const regularPool = {
      name: "BONK-SOL",
      pool_address: "RegularPoolAddr1111111111111111111111111111111",
      volume: 15000,
      tvl: 50000,
      active_tvl: 40000,
      fee: 0.01,
      fee_active_tvl_ratio: 0.05,
      volatility: 3.5,
      base_token_holders: 500,
      dlmm_params: { bin_step: 100 },
      token_x: { organic_score: 80, market_cap: 250000 },
      token_y: { organic_score: 60 },
    };

    globalThis.fetch = buildMockFetch({ regularPools: [regularPool] });

    const { discoverPools } = await import("../../tools/screening.js");
    await discoverPools({ page_size: 5 });

    expect(countEnrichmentCalls(globalThis.fetch)).toBe(0);
  });

  it("skips pools with null pool_address", async () => {
    const candidate = makeDiscordSignalCandidate();
    candidate.discovery_pool.pool_address = null;

    globalThis.fetch = buildMockFetch({ discordCandidates: [candidate] });

    const { discoverPools } = await import("../../tools/screening.js");
    await discoverPools({ page_size: 5 });

    expect(countEnrichmentCalls(globalThis.fetch)).toBe(0);
  });

  it("does nothing when no Discord signals present", async () => {
    globalThis.fetch = buildMockFetch();

    const { discoverPools } = await import("../../tools/screening.js");
    const result = await discoverPools({ page_size: 5 });

    expect(result.pools).toEqual([]);
    expect(countEnrichmentCalls(globalThis.fetch)).toBe(0);
  });

  it("does nothing when all Discord signals already have all critical fields", async () => {
    const candidate = makeDiscordSignalCandidate();
    candidate.discovery_pool.volume = 12000;
    candidate.discovery_pool.tvl = 50000;
    candidate.discovery_pool.base_token_holders = 500;
    candidate.discovery_pool.dlmm_params = { bin_step: 100 };
    candidate.discovery_pool.token_x = {
      organic_score: 80,
      market_cap: 500000,
      created_at: "2026-01-01T00:00:00Z",
    };

    globalThis.fetch = buildMockFetch({ discordCandidates: [candidate] });

    const { discoverPools } = await import("../../tools/screening.js");
    await discoverPools({ page_size: 5 });

    expect(countEnrichmentCalls(globalThis.fetch)).toBe(0);
  });

  // ────────────────────────────────────────────────
  // Enriched pool passes screening
  // ────────────────────────────────────────────────

  it("enriched Discord pool passes screening and appears in results", async () => {
    const candidate = makeDiscordSignalCandidate();
    const poolAddr = candidate.discovery_pool.pool_address;

    globalThis.fetch = buildMockFetch({
      discordCandidates: [candidate],
      meteoraDetails: { [poolAddr]: makeMeteoraDetail() },
    });

    const { discoverPools } = await import("../../tools/screening.js");
    const result = await discoverPools({ page_size: 5 });

    const pool = result.pools.find((p) => p.pool === poolAddr);
    expect(pool).toBeDefined();
    expect(pool.volume_window).toBeDefined();
  });

  it("un-enriched pool with volume=0 is filtered out", async () => {
    const candidate = makeDiscordSignalCandidate();
    const poolAddr = candidate.discovery_pool.pool_address;

    globalThis.fetch = buildMockFetch({ discordCandidates: [candidate] });

    const { discoverPools } = await import("../../tools/screening.js");
    const result = await discoverPools({ page_size: 5 });

    const pool = result.pools.find((p) => p.pool === poolAddr);
    expect(pool).toBeUndefined();
  });

  it("enriched pool with volume passes minVolume filter", async () => {
    const candidate = makeDiscordSignalCandidate();
    candidate.discovery_pool.volume = 0;
    const poolAddr = candidate.discovery_pool.pool_address;

    globalThis.fetch = buildMockFetch({
      discordCandidates: [candidate],
      meteoraDetails: { [poolAddr]: makeMeteoraDetail({ volume: 50000 }) },
    });

    const { discoverPools } = await import("../../tools/screening.js");
    const result = await discoverPools({ page_size: 5 });

    expect(result.pools.find((p) => p.pool === poolAddr)).toBeDefined();
  });

  // ────────────────────────────────────────────────
  // Error handling
  // ────────────────────────────────────────────────

  it("handles API failure gracefully (Promise.allSettled)", async () => {
    const candidate = makeDiscordSignalCandidate();

    globalThis.fetch = buildMockFetch({
      discordCandidates: [candidate],
      meteoraDetails: {},
    });

    const { discoverPools } = await import("../../tools/screening.js");
    const result = await discoverPools({ page_size: 5 });
    expect(result).toBeDefined();
  });

  it("handles fetch throwing for enrichment without crashing", async () => {
    const candidate = makeDiscordSignalCandidate();

    globalThis.fetch = vi.fn(async (url) => {
      const s = typeof url === "string" ? url : url.toString();
      if (s.includes("/signals/discord/candidates")) {
        return { ok: true, json: async () => ({ candidates: [candidate] }) };
      }
      if (isPoolDiscoveryDetailUrl(s)) throw new Error("Network timeout");
      if (s.includes("pool-discovery-api.datapi.meteora.ag/pools")) {
        return { ok: true, json: async () => ({ data: [], total: 0 }) };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    });

    const { discoverPools } = await import("../../tools/screening.js");
    const result = await discoverPools({ page_size: 5 });
    expect(result).toBeDefined();
  });

  // ────────────────────────────────────────────────
  // Merge behavior
  // ────────────────────────────────────────────────

  it("does NOT overwrite existing pool fields (only fills null/missing)", async () => {
    const candidate = makeDiscordSignalCandidate();
    candidate.discovery_pool.dlmm_params = { bin_step: 125 };
    const poolAddr = candidate.discovery_pool.pool_address;

    globalThis.fetch = buildMockFetch({
      discordCandidates: [candidate],
      meteoraDetails: { [poolAddr]: makeMeteoraDetail({ dlmm_params: { bin_step: 80 } }) },
    });

    const { discoverPools } = await import("../../tools/screening.js");
    const result = await discoverPools({ page_size: 5 });

    const pool = result.pools.find((p) => p.pool === poolAddr);
    expect(pool).toBeDefined();
    expect(pool.bin_step).toBe(125);
  });

  it("creates dlmm_params when pool has none but Meteora has bin_step", async () => {
    const candidate = makeDiscordSignalCandidate();
    candidate.discovery_pool.dlmm_params = null;
    const poolAddr = candidate.discovery_pool.pool_address;

    globalThis.fetch = buildMockFetch({
      discordCandidates: [candidate],
      meteoraDetails: { [poolAddr]: makeMeteoraDetail() },
    });

    const { discoverPools } = await import("../../tools/screening.js");
    const result = await discoverPools({ page_size: 5 });

    const pool = result.pools.find((p) => p.pool === poolAddr);
    expect(pool).toBeDefined();
    expect(pool.bin_step).toBe(100);
  });

  it("does NOT overwrite existing bin_step", async () => {
    const candidate = makeDiscordSignalCandidate();
    candidate.discovery_pool.dlmm_params = { bin_step: 125 };
    const poolAddr = candidate.discovery_pool.pool_address;

    globalThis.fetch = buildMockFetch({
      discordCandidates: [candidate],
      meteoraDetails: { [poolAddr]: makeMeteoraDetail({ dlmm_params: { bin_step: 80 } }) },
    });

    const { discoverPools } = await import("../../tools/screening.js");
    const result = await discoverPools({ page_size: 5 });

    const pool = result.pools.find((p) => p.pool === poolAddr);
    expect(pool).toBeDefined();
    expect(pool.bin_step).toBe(125);
  });

  it("merges token_x organic_score from Meteora into pool", async () => {
    const candidate = makeDiscordSignalCandidate();
    const poolAddr = candidate.discovery_pool.pool_address;

    globalThis.fetch = buildMockFetch({
      discordCandidates: [candidate],
      meteoraDetails: { [poolAddr]: makeMeteoraDetail() },
    });

    const { discoverPools } = await import("../../tools/screening.js");
    const result = await discoverPools({ page_size: 5 });

    const pool = result.pools.find((p) => p.pool === poolAddr);
    expect(pool).toBeDefined();
    expect(pool.organic_score).toBe(80);
  });

  it("does NOT overwrite existing token_x fields", async () => {
    const candidate = makeDiscordSignalCandidate();
    candidate.discovery_pool.base_token_holders = 500;
    candidate.discovery_pool.token_x = {
      organic_score: 95,
      market_cap: 1000000,
      created_at: "2025-01-01T00:00:00Z",
    };
    const poolAddr = candidate.discovery_pool.pool_address;

    globalThis.fetch = buildMockFetch({
      discordCandidates: [candidate],
      meteoraDetails: { [poolAddr]: makeMeteoraDetail() },
    });

    const { discoverPools } = await import("../../tools/screening.js");
    const result = await discoverPools({ page_size: 5 });

    const pool = result.pools.find((p) => p.pool === poolAddr);
    expect(pool).toBeDefined();
    expect(pool.organic_score).toBe(95);
  });

  it("preserves existing pool name even when Meteora has different name", async () => {
    const candidate = makeDiscordSignalCandidate();
    candidate.discovery_pool.name = "CUSTOM-NAME";
    const poolAddr = candidate.discovery_pool.pool_address;

    globalThis.fetch = buildMockFetch({
      discordCandidates: [candidate],
      meteoraDetails: { [poolAddr]: makeMeteoraDetail({ name: "DOGE-SOL-Meteora" }) },
    });

    const { discoverPools } = await import("../../tools/screening.js");
    const result = await discoverPools({ page_size: 5 });

    const pool = result.pools.find((p) => p.pool === poolAddr);
    expect(pool).toBeDefined();
    expect(pool.name).toBe("CUSTOM-NAME");
  });

  // ────────────────────────────────────────────────
  // Volume edge cases
  // ────────────────────────────────────────────────

  it("triggers enrichment for volume as string '0'", async () => {
    const candidate = makeDiscordSignalCandidate();
    candidate.discovery_pool.volume = "0";
    const poolAddr = candidate.discovery_pool.pool_address;

    globalThis.fetch = buildMockFetch({
      discordCandidates: [candidate],
      meteoraDetails: { [poolAddr]: makeMeteoraDetail() },
    });

    const { discoverPools } = await import("../../tools/screening.js");
    const result = await discoverPools({ page_size: 5 });

    expect(countEnrichmentCalls(globalThis.fetch)).toBe(1);
    expect(result.pools.find((p) => p.pool === poolAddr)).toBeDefined();
  });

  it("triggers enrichment for non-numeric volume string", async () => {
    const candidate = makeDiscordSignalCandidate();
    candidate.discovery_pool.volume = "not-a-number";
    const poolAddr = candidate.discovery_pool.pool_address;

    globalThis.fetch = buildMockFetch({
      discordCandidates: [candidate],
      meteoraDetails: { [poolAddr]: makeMeteoraDetail() },
    });

    const { discoverPools } = await import("../../tools/screening.js");
    const result = await discoverPools({ page_size: 5 });

    expect(countEnrichmentCalls(globalThis.fetch)).toBe(1);
    expect(result.pools.find((p) => p.pool === poolAddr)).toBeDefined();
  });

  // ────────────────────────────────────────────────
  // Multiple pools
  // ────────────────────────────────────────────────

  it("enriches multiple Discord signal pools in parallel", async () => {
    const c1 = makeDiscordSignalCandidate();
    c1.discovery_pool.pool_address = "PoolAddr11111111111111111111111111111111";
    c1.discovery_pool.name = "POOL-1";

    const c2 = makeDiscordSignalCandidate();
    c2.discovery_pool.pool_address = "PoolAddr22222222222222222222222222222222";
    c2.discovery_pool.name = "POOL-2";

    globalThis.fetch = buildMockFetch({
      discordCandidates: [c1, c2],
      meteoraDetails: {
        [c1.discovery_pool.pool_address]: makeMeteoraDetail({
          pool_address: c1.discovery_pool.pool_address, name: "POOL-1",
        }),
        [c2.discovery_pool.pool_address]: makeMeteoraDetail({
          pool_address: c2.discovery_pool.pool_address, name: "POOL-2",
        }),
      },
    });

    const { discoverPools } = await import("../../tools/screening.js");
    const result = await discoverPools({ page_size: 5 });

    expect(countEnrichmentCalls(globalThis.fetch)).toBe(2);
    expect(result.pools.find((p) => p.pool === c1.discovery_pool.pool_address)).toBeDefined();
    expect(result.pools.find((p) => p.pool === c2.discovery_pool.pool_address)).toBeDefined();
  });

  // ────────────────────────────────────────────────
  // Partial Meteora data
  // ────────────────────────────────────────────────

  it("handles partial Meteora data (only volume, rest null)", async () => {
    const candidate = makeDiscordSignalCandidate();
    const poolAddr = candidate.discovery_pool.pool_address;

    globalThis.fetch = buildMockFetch({
      discordCandidates: [candidate],
      meteoraDetails: {
        [poolAddr]: {
          pool_address: poolAddr,
          name: "DOGE-SOL",
          volume: 50000,
          tvl: null,
          active_tvl: null,
          fee: null,
          fee_active_tvl_ratio: null,
          volatility: null,
          base_token_holders: null,
          dlmm_params: null,
          token_x: null,
          token_y: null,
        },
      },
    });

    const { discoverPools } = await import("../../tools/screening.js");
    const result = await discoverPools({ page_size: 5 });
    expect(result).toBeDefined();
    expect(countEnrichmentCalls(globalThis.fetch)).toBe(1);
    // Volume enriched but mcap still missing — filtered by screening
    expect(result.pools.find((p) => p.pool === poolAddr)).toBeUndefined();
  });
});
