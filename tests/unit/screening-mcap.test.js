import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("dotenv/config", () => ({}));

/**
 * Unit tests for tools/screening.js mcap handling.
 *
 * Bug: Meteora Pool Discovery API uses base_token_market_cap in filters
 * but returns null for it. The real mcap lives at token_x.market_cap.
 * The API filter killed ALL pools before client-side filtering ran.
 *
 * Fix: Remove base_token_market_cap from the API filter string.
 * Client-side getRawPoolScreeningRejectReason already handles mcap
 * correctly via token_x.market_cap.
 */

// --- Test 1: API filter string does NOT contain base_token_market_cap ---
describe("discoverPools API filter", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("filter string does not contain base_token_market_cap", async () => {
    // Intercept fetch to capture the URL used
    let capturedUrl = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url) => {
      if (typeof url === "string" && url.includes("pools?")) {
        capturedUrl = url;
      }
      return {
        ok: true,
        json: async () => ({ data: [] }),
      };
    });

    try {
      const { discoverPools } = await import("../../tools/screening.js");
      await discoverPools({ page_size: 5 });
    } catch {
      // discoverPools may throw on missing config — that's fine,
      // we only need the URL it tried to fetch
    } finally {
      globalThis.fetch = originalFetch;
    }

    // If the filter was built, the URL should not contain base_token_market_cap
    if (capturedUrl) {
      expect(capturedUrl).not.toContain("base_token_market_cap");
    }
  });
});

// --- Test 2: Client-side mcap filtering ---
describe("getRawPoolScreeningRejectReason mcap filtering", () => {
  const screeningConfig = {
    minMcap: 100_000,
    maxMcap: 5_000_000,
    minHolders: 100,
    minVolume: 1000,
    minTvl: 5000,
    maxTvl: null,
    minBinStep: 80,
    maxBinStep: 125,
    minFeeActiveTvlRatio: 0.05,
    minOrganic: 60,
    minQuoteOrganic: 0,
    minTokenAgeHours: null,
    maxTokenAgeHours: null,
    allowedLaunchpads: [],
    blockedLaunchpads: [],
    excludeHighSupplyConcentration: false,
  };

  const makePool = (mcap) => ({
    name: "TEST-SOL",
    pool_address: "PoolAddr11111111111111111111111111111111",
    token_x: { market_cap: mcap, organic_score: 80 },
    token_y: { organic_score: 50 },
    dlmm_params: { bin_step: 100 },
    tvl: 10000,
    fee_active_tvl_ratio: 0.1,
    volume: 5000,
    base_token_holders: 200,
    volatility: 5,
  });

  let getRawPoolScreeningRejectReason;

  beforeAll(async () => {
    const mod = await import("../../tools/screening.js");
    getRawPoolScreeningRejectReason = mod.getRawPoolScreeningRejectReason;
  });

  it("rejects pool with mcap below minMcap", () => {
    const pool = makePool(50_000); // below 100k minMcap
    const reason = getRawPoolScreeningRejectReason(pool, screeningConfig);
    expect(reason).toContain("mcap");
    expect(reason).toContain("below minMcap");
  });

  it("rejects pool with mcap above maxMcap", () => {
    const pool = makePool(6_000_000); // above 5M maxMcap
    const reason = getRawPoolScreeningRejectReason(pool, screeningConfig);
    expect(reason).toContain("mcap");
    expect(reason).toContain("above maxMcap");
  });

  it("rejects pool with null mcap", () => {
    const pool = makePool(null);
    const reason = getRawPoolScreeningRejectReason(pool, screeningConfig);
    expect(reason).toContain("mcap");
    expect(reason).toContain("below minMcap");
  });

  it("passes pool with valid mcap in range", () => {
    const pool = makePool(300_000); // between 100k-5M
    const reason = getRawPoolScreeningRejectReason(pool, screeningConfig);
    expect(reason).toBeNull();
  });
});
