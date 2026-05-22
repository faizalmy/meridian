import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("dotenv/config", () => ({}));

/**
 * Unit tests for enrichDiscordSignalPoolData in tools/screening.js.
 *
 * Design: Discord signals only provide token name/mint/pool_address (signal).
 * Meteora Pool Discovery API is the source of truth for all pool data.
 * enrichDiscordSignalPoolData always fetches from Meteora for Discord pools.
 */

// ─── Config mock ────────────────────────────────
// We mock config.js directly (not via mock-fs) because vi.mock("fs") in a
// helper module doesn't propagate to config.js when it's dynamically imported
// by screening.js.

function makeScreeningConfig(overrides = {}) {
  return {
    excludeHighSupplyConcentration: false,
    minFeeActiveTvlRatio: 0.05,
    minTvl: 10_000,
    maxTvl: 150_000,
    minVolume: 500,
    minOrganic: 60,
    minQuoteOrganic: 60,
    minHolders: 500,
    minMcap: 150_000,
    maxMcap: 10_000_000,
    minBinStep: 80,
    maxBinStep: 125,
    timeframe: "5m",
    category: "trending",
    minTokenFeesSol: 30,
    useDiscordSignals: true,
    discordSignalMode: "merge",
    avoidPvpSymbols: false,
    blockPvpSymbols: false,
    maxBundlePct: 30,
    maxBotHoldersPct: 30,
    maxTop10Pct: 60,
    allowedLaunchpads: [],
    blockedLaunchpads: [],
    minTokenAgeHours: null,
    maxTokenAgeHours: null,
    athFilterPct: null,
    maxSellPct: null,
    ...overrides,
  };
}

// Mutable config object — tests can modify it before importing screening.js
let _screening = makeScreeningConfig();

const mockConfig = {
  get screening() { return _screening; },
  tokens: { SOL: "So11111111111111111111111111111111111111112" },
  api: { url: "https://api.agentmeridian.xyz/api" },
  risk: { maxPositions: 10, maxDeployAmount: 50, deployAmountSol: 0.5 },
  management: {
    autoSwapAfterClaim: false,
    gasReserve: 0.2,
    minSolToOpen: 0.55,
    positionSizePct: 0.35,
    deployAmountSol: 0.5,
    outOfRangeWaitMinutes: 30,
    stopLossPct: -50,
    takeProfitPct: 5,
  },
  strategy: { minBinsBelow: 5, maxBinsBelow: 15 },
};

vi.mock("../../config.js", () => ({
  config: mockConfig,
  MIN_SAFE_BINS_BELOW: 5,
  reloadScreeningThresholds: vi.fn(),
}));

vi.mock("../../logger.js", () => ({
  log: vi.fn(),
  logAction: vi.fn(),
}));

vi.mock("../../token-blacklist.js", () => ({
  isBlacklisted: vi.fn(() => false),
}));

vi.mock("../../dev-blocklist.js", () => ({
  isDevBlocked: vi.fn(() => false),
  getBlockedDevs: vi.fn(() => ({})),
}));

vi.mock("../../pool-memory.js", () => ({
  isBaseMintOnCooldown: vi.fn(() => false),
  isPoolOnCooldown: vi.fn(() => false),
}));

vi.mock("./chart-indicators.js", () => ({
  confirmIndicatorPreset: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("./agent-meridian.js", () => ({
  getAgentMeridianBase: () => "https://api.agentmeridian.xyz/api",
  getAgentMeridianHeaders: () => ({ "x-api-key": "test-key" }),
}));

function makeDiscordSignalCandidate(overrides = {}) {
  return {
    discovery_pool: {
      name: "DOGE-SOL",
      pool_address: "DiscordPoolAddr1111111111111111111111111111",
      pool_type: "dlmm",
      token_x: { address: "TokenMintAddr1111111111111111111111111111111111" },
      ...overrides,
    },
    base_symbol: "DOGE",
    base_mint: "TokenMintAddr1111111111111111111111111111111111",
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
      address: "TokenMintAddr1111111111111111111111111111111111",
    },
    token_y: { organic_score: 70 },
    ...overrides,
  };
}

/**
 * Build a mock fetch that handles:
 * - Discord signal candidates
 * - Meteora pool discovery (detail + search)
 * - Jupiter asset search (for enrichDiscordSignalLaunchpads)
 */
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

    // Meteora pool discovery detail (page_size=1)
    if (
      urlStr.includes("pool-discovery-api.datapi.meteora.ag/pools") &&
      urlStr.includes("page_size=1")
    ) {
      const filterMatch = urlStr.match(/filter_by=([^&]+)/);
      const filter = filterMatch ? decodeURIComponent(filterMatch[1]) : "";
      const poolMatch = filter.match(/pool_address=(.+)/);
      const poolAddr = poolMatch ? poolMatch[1] : null;
      const detail = poolAddr ? meteoraDetails[poolAddr] || null : null;
      return {
        ok: true,
        json: async () => ({ data: detail ? [detail] : [] }),
      };
    }

    // Meteora pool discovery search (no page_size=1)
    if (urlStr.includes("pool-discovery-api.datapi.meteora.ag/pools")) {
      return {
        ok: true,
        json: async () => ({ data: regularPools, total: regularPools.length }),
      };
    }

    // Jupiter asset search (enrichDiscordSignalLaunchpads)
    if (urlStr.includes("datapi.jup.ag/assets/search")) {
      return {
        ok: true,
        json: async () => [
          {
            id: "TokenMintAddr1111111111111111111111111111111111",
            symbol: "DOGE",
            launchpad: "pump.fun",
            dev: "DevAddr111111111111111111111111111111111",
            holderCount: 500,
            organicScore: 80,
            mcap: 500000,
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      };
    }

    return { ok: true, json: async () => ({ data: [] }) };
  });
}

describe("enrichDiscordSignalPoolData", () => {
  beforeEach(() => {
    // Reset config to defaults before each test
    _screening = makeScreeningConfig();
    vi.resetModules();
  });

  afterEach(() => {
    delete globalThis.fetch;
  });

  it("always enriches Discord signal pools (Meteora is source of truth)", async () => {
    const candidate = makeDiscordSignalCandidate();
    const poolAddr = candidate.discovery_pool.pool_address;

    globalThis.fetch = buildMockFetch({
      discordCandidates: [candidate],
      meteoraDetails: { [poolAddr]: makeMeteoraDetail() },
    });

    const { discoverPools } = await import("../../tools/screening.js");
    const result = await discoverPools({ page_size: 5 });

    // After enrichment + screening, the Discord pool should appear in results
    const pool = result.pools.find((p) => p.pool === poolAddr);
    expect(pool).toBeDefined();
    expect(pool.volume_window).toBe(50000);
  });

  it("skips enrichment for non-Discord signal pools", async () => {
    // A regular pool that already has all screening-passing data
    const regularPool = {
      name: "BONK-SOL",
      pool_address: "RegularPoolAddr111111111111111111111111111",
      pool_type: "dlmm",
      volume: 10000,
      tvl: 50000,
      active_tvl: 45000,
      fee: 0.005,
      fee_active_tvl_ratio: 0.10,
      volatility: 15.0,
      base_token_holders: 1000,
      dlmm_params: { bin_step: 100 },
      token_x: { organic_score: 80, market_cap: 500000, symbol: "BONK", address: "BonkMintAddr11111111111111111111111111111" },
      token_y: { organic_score: 70 },
    };

    globalThis.fetch = buildMockFetch({ regularPools: [regularPool] });

    const { discoverPools } = await import("../../tools/screening.js");
    const result = await discoverPools({ page_size: 5 });

    // Regular pool should appear in results — it was NOT treated as a Discord signal
    const pool = result.pools.find((p) => p.pool === regularPool.pool_address);
    expect(pool).toBeDefined();
    // Regular pool should have its original data, not skeleton enrichment
    expect(pool.name).toBe("BONK-SOL");
    expect(pool.volume_window).toBe(10000);
  });

  it("skips pools with null pool_address", async () => {
    const candidate = makeDiscordSignalCandidate();
    candidate.discovery_pool.pool_address = null;

    globalThis.fetch = buildMockFetch({ discordCandidates: [candidate] });

    const { discoverPools } = await import("../../tools/screening.js");
    const result = await discoverPools({ page_size: 5 });

    // null pool_address candidates are dropped — no enrichment calls made for them
    expect(result.pools).toEqual([]);
  });

  it("does nothing when no Discord signals present", async () => {
    globalThis.fetch = buildMockFetch();

    const { discoverPools } = await import("../../tools/screening.js");
    const result = await discoverPools({ page_size: 5 });

    expect(result.pools).toEqual([]);
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

  it("pool without Meteora enrichment is filtered out (no data)", async () => {
    const candidate = makeDiscordSignalCandidate();
    const poolAddr = candidate.discovery_pool.pool_address;

    // No meteoraDetails — enrichment will return empty data
    globalThis.fetch = buildMockFetch({ discordCandidates: [candidate] });

    const { discoverPools } = await import("../../tools/screening.js");
    const result = await discoverPools({ page_size: 5 });

    const pool = result.pools.find((p) => p.pool === poolAddr);
    expect(pool).toBeUndefined();
  });

  it("enriched pool with volume passes minVolume filter", async () => {
    const candidate = makeDiscordSignalCandidate();
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
      meteoraDetails: {},  // no enrichment data
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
      // Throw for all Meteora detail calls (both enrichment and volatility)
      if (s.includes("pool-discovery-api.datapi.meteora.ag/pools") && s.includes("page_size=1")) {
        throw new Error("Network timeout");
      }
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
  // Meteora is source of truth
  // ────────────────────────────────────────────────

  it("Meteora data overwrites all skeleton fields", async () => {
    const candidate = makeDiscordSignalCandidate();
    const poolAddr = candidate.discovery_pool.pool_address;

    globalThis.fetch = buildMockFetch({
      discordCandidates: [candidate],
      meteoraDetails: { [poolAddr]: makeMeteoraDetail({ dlmm_params: { bin_step: 80 } }) },
    });

    const { discoverPools } = await import("../../tools/screening.js");
    const result = await discoverPools({ page_size: 5 });

    const pool = result.pools.find((p) => p.pool === poolAddr);
    expect(pool).toBeDefined();
    expect(pool.bin_step).toBe(80);
    expect(pool.organic_score).toBe(80);
    expect(pool.mcap).toBe(500000);
  });

  it("creates dlmm_params from Meteora when skeleton has none", async () => {
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
    expect(pool.bin_step).toBe(100);
  });

  it("Meteora token_x data overwrites skeleton", async () => {
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
    expect(pool.mcap).toBe(500000);
  });

  it("uses base_symbol fallback when skeleton has no name, Meteora enriches further", async () => {
    const candidate = makeDiscordSignalCandidate();
    delete candidate.discovery_pool.name;
    const poolAddr = candidate.discovery_pool.pool_address;

    globalThis.fetch = buildMockFetch({
      discordCandidates: [candidate],
      meteoraDetails: { [poolAddr]: makeMeteoraDetail({ name: "DOGE-SOL-Meteora" }) },
    });

    const { discoverPools } = await import("../../tools/screening.js");
    const result = await discoverPools({ page_size: 5 });

    const pool = result.pools.find((p) => p.pool === poolAddr);
    expect(pool).toBeDefined();
    // Skeleton fallback from base_symbol, not overridden by Meteora since name already set
    expect(pool.name).toBe("DOGE-SOL");
  });

  // ────────────────────────────────────────────────
  // Multiple pools
  // ────────────────────────────────────────────────

  it("enriches multiple Discord signal pools in parallel", async () => {
    const c1 = makeDiscordSignalCandidate();
    c1.discovery_pool.pool_address = "PoolAddr11111111111111111111111111111111";
    c1.discovery_pool.name = "POOL-1";
    c1.base_mint = "TokenMint1111111111111111111111111111111111";

    const c2 = makeDiscordSignalCandidate();
    c2.discovery_pool.pool_address = "PoolAddr22222222222222222222222222222222";
    c2.discovery_pool.name = "POOL-2";
    c2.base_mint = "TokenMint2222222222222222222222222222222222";

    globalThis.fetch = buildMockFetch({
      discordCandidates: [c1, c2],
      meteoraDetails: {
        [c1.discovery_pool.pool_address]: makeMeteoraDetail({
          pool_address: c1.discovery_pool.pool_address, name: "POOL-1",
          token_x: {
            organic_score: 80, market_cap: 500000,
            created_at: "2026-01-01T00:00:00Z",
            symbol: "POOL1", address: "TokenMint1111111111111111111111111111111111",
          },
        }),
        [c2.discovery_pool.pool_address]: makeMeteoraDetail({
          pool_address: c2.discovery_pool.pool_address, name: "POOL-2",
          token_x: {
            organic_score: 80, market_cap: 500000,
            created_at: "2026-01-01T00:00:00Z",
            symbol: "POOL2", address: "TokenMint2222222222222222222222222222222222",
          },
        }),
      },
    });

    const { discoverPools } = await import("../../tools/screening.js");
    const result = await discoverPools({ page_size: 5 });

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
    // Volume enriched but mcap still missing — filtered by screening
    expect(result.pools.find((p) => p.pool === poolAddr)).toBeUndefined();
  });

  // ────────────────────────────────────────────────
  // Discord signal mode: only
  // ────────────────────────────────────────────────

  it("in 'only' mode, uses only Discord signals (no Meteora regular pools)", async () => {
    // Switch to "only" mode before importing screening.js
    _screening = makeScreeningConfig({
      useDiscordSignals: true,
      discordSignalMode: "only",
    });

    const candidate = makeDiscordSignalCandidate();
    const poolAddr = candidate.discovery_pool.pool_address;
    const regularPool = {
      name: "BONK-SOL",
      pool_address: "RegularPoolAddr111111111111111111111111111",
      volume: 10000,
      tvl: 50000,
    };

    globalThis.fetch = buildMockFetch({
      regularPools: [regularPool],
      discordCandidates: [candidate],
      meteoraDetails: { [poolAddr]: makeMeteoraDetail() },
    });

    const { discoverPools } = await import("../../tools/screening.js");
    const result = await discoverPools({ page_size: 5 });

    expect(result.pools.find((p) => p.pool === poolAddr)).toBeDefined();
    expect(result.pools.find((p) => p.pool === "RegularPoolAddr111111111111111111111111111")).toBeUndefined();
  });
});
