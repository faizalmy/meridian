import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock fetch globally ────────────────────────────────────────
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Helper: create a mock Response
function mockResponse(body, { status = 200, headers = {} } = {}) {
  const h = new Map(Object.entries(headers));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => h.get(k) ?? null },
    json: () => Promise.resolve(body),
  };
}

// Sample pair object matching DexScreener API shape
const SAMPLE_PAIR = {
  chainId: "solana",
  dexId: "raydium",
  pairAddress: "POOL_ADDR_1",
  baseToken: { address: "MINT_A", symbol: "TOKEN_A", name: "Token A" },
  quoteToken: { address: "So11111111111111111111111111111111111111112", symbol: "SOL" },
  priceUsd: "1.23",
  priceChange: { m5: 1.5, h1: 3.2, h6: -1.0, h24: 12.5 },
  volume: { m5: 100, h1: 5000, h6: 30000, h24: 120000 },
  liquidity: { usd: 50000, base: 20000, quote: 25000 },
  txns: { h1: { buys: 80, sells: 40 }, h6: { buys: 300, sells: 200 }, h24: { buys: 1200, sells: 900 } },
  boosts: { active: 3 },
};

const SAMPLE_PAIR_2 = {
  ...SAMPLE_PAIR,
  pairAddress: "POOL_ADDR_2",
  baseToken: { address: "MINT_B", symbol: "TOKEN_B", name: "Token B" },
  volume: { h24: 80000 },
};

// Import after mocking fetch
let mod;
let clearCaches;
async function loadModule() {
  vi.resetModules();
  mod = await import("../../tools/dexscreener.js");
  clearCaches = mod.clearDexScreenerCaches;
}

beforeEach(async () => {
  mockFetch.mockReset();
  await loadModule();
  clearCaches(); // clear the NEW module's caches after loading
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ══════════════════════════════════════════════════════════════
// extractPairMetrics — pure function, no fetch
// ══════════════════════════════════════════════════════════════

describe("extractPairMetrics", () => {
  it("returns null for null input", () => {
    expect(mod.extractPairMetrics(null)).toBeNull();
    expect(mod.extractPairMetrics(undefined)).toBeNull();
  });

  it("extracts all fields from a full pair object", () => {
    const m = mod.extractPairMetrics(SAMPLE_PAIR);
    expect(m).toEqual({
      ds_buys_1h: 80,
      ds_sells_1h: 40,
      ds_buy_ratio_1h: 2,
      ds_buy_pct_1h: 67,
      ds_price_change_5m: 1.5,
      ds_price_change_1h: 3.2,
      ds_price_change_6h: -1.0,
      ds_price_change_24h: 12.5,
      ds_volume_1h: 5000,
      ds_volume_6h: 30000,
      ds_volume_24h: 120000,
      ds_liquidity_usd: 50000,
      ds_boosts_active: 3,
      ds_dex: "raydium",
      ds_pair_address: "POOL_ADDR_1",
    });
  });

  it("handles missing txns gracefully", () => {
    const pair = { chainId: "solana", pairAddress: "X" };
    const m = mod.extractPairMetrics(pair);
    expect(m.ds_buys_1h).toBe(0);
    expect(m.ds_sells_1h).toBe(0);
    expect(m.ds_buy_ratio_1h).toBeNull();
    expect(m.ds_buy_pct_1h).toBeNull();
  });

  it("handles zero sells (division by zero)", () => {
    const pair = { txns: { h1: { buys: 10, sells: 0 } } };
    const m = mod.extractPairMetrics(pair);
    expect(m.ds_buy_ratio_1h).toBeNull(); // 10/0 = Infinity → null via total check
    expect(m.ds_buy_pct_1h).toBe(100);
  });

  it("handles missing priceChange/volume/liquidity fields", () => {
    const pair = { txns: { h1: { buys: 5, sells: 5 } } };
    const m = mod.extractPairMetrics(pair);
    expect(m.ds_price_change_5m).toBeNull();
    expect(m.ds_volume_1h).toBeNull();
    expect(m.ds_liquidity_usd).toBeNull();
    expect(m.ds_boosts_active).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════
// getDexScreenerPair — single pool lookup
// ══════════════════════════════════════════════════════════════

describe("getDexScreenerPair", () => {
  it("returns null for falsy pairAddress", async () => {
    expect(await mod.getDexScreenerPair({ pairAddress: null })).toBeNull();
    expect(await mod.getDexScreenerPair({ pairAddress: "" })).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fetches and returns first Solana pair", async () => {
    mockFetch.mockResolvedValue(mockResponse({ pairs: [SAMPLE_PAIR] }));
    const result = await mod.getDexScreenerPair({ pairAddress: "POOL_ADDR_1" });
    expect(result).toEqual(SAMPLE_PAIR);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/latest/dex/pairs/solana/POOL_ADDR_1")
    );
  });

  it("prefers Solana pair when mixed chains returned", async () => {
    const ethPair = { chainId: "ethereum", pairAddress: "ETH_PAIR" };
    mockFetch.mockResolvedValue(mockResponse({ pairs: [ethPair, SAMPLE_PAIR] }));
    const result = await mod.getDexScreenerPair({ pairAddress: "POOL_ADDR_1" });
    expect(result.chainId).toBe("solana");
  });

  it("returns null on non-ok response", async () => {
    mockFetch.mockResolvedValue(mockResponse(null, { status: 500 }));
    const result = await mod.getDexScreenerPair({ pairAddress: "POOL_ADDR_1" });
    expect(result).toBeNull();
  });

  it("returns cached result on second call (no fetch)", async () => {
    mockFetch.mockResolvedValue(mockResponse({ pairs: [SAMPLE_PAIR] }));
    await mod.getDexScreenerPair({ pairAddress: "POOL_ADDR_1" });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const cached = await mod.getDexScreenerPair({ pairAddress: "POOL_ADDR_1" });
    expect(cached).toEqual(SAMPLE_PAIR);
    expect(mockFetch).toHaveBeenCalledTimes(1); // no second fetch
  });

  it("returns stale cache on 429", async () => {
    // First call succeeds → populates cache
    mockFetch.mockResolvedValueOnce(mockResponse({ pairs: [SAMPLE_PAIR] }));
    await mod.getDexScreenerPair({ pairAddress: "POOL_ADDR_1" });

    // Second call returns 429 → should return cached data
    mockFetch.mockResolvedValueOnce(mockResponse(null, { status: 429, headers: { "retry-after": "1" } }));
    const result = await mod.getDexScreenerPair({ pairAddress: "POOL_ADDR_1" });
    expect(result).toEqual(SAMPLE_PAIR);
  });
});

// ══════════════════════════════════════════════════════════════
// getDexScreenerBatch — batch token lookup
// ══════════════════════════════════════════════════════════════

describe("getDexScreenerBatch", () => {
  it("returns empty Map for empty mints", async () => {
    const result = await mod.getDexScreenerBatch({ mints: [] });
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns empty Map for null/undefined mints", async () => {
    expect((await mod.getDexScreenerBatch({ mints: null })).size).toBe(0);
    expect((await mod.getDexScreenerBatch({})).size).toBe(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fetches multiple mints in a single API call", async () => {
    // API returns flat array of pairs for all requested tokens
    mockFetch.mockResolvedValue(mockResponse([SAMPLE_PAIR, SAMPLE_PAIR_2]));

    const result = await mod.getDexScreenerBatch({ mints: ["MINT_A", "MINT_B"] });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/tokens/v1/solana/MINT_A,MINT_B")
    );
    expect(result.get("MINT_A")).toHaveLength(1);
    expect(result.get("MINT_B")).toHaveLength(1);
  });

  it("groups pairs by base token and sorts by volume", async () => {
    const lowVolPair = { ...SAMPLE_PAIR, baseToken: { address: "MINT_A" }, volume: { h24: 1000 } };
    const highVolPair = { ...SAMPLE_PAIR, baseToken: { address: "MINT_A" }, volume: { h24: 50000 } };

    mockFetch.mockResolvedValue(mockResponse([lowVolPair, highVolPair]));

    const result = await mod.getDexScreenerBatch({ mints: ["MINT_A"] });
    const pairs = result.get("MINT_A");
    expect(pairs).toHaveLength(2);
    // Should be sorted by volume descending
    expect(pairs[0].volume.h24).toBe(50000);
    expect(pairs[1].volume.h24).toBe(1000);
  });

  it("filters out non-Solana pairs", async () => {
    const ethPair = { chainId: "ethereum", baseToken: { address: "MINT_A" } };
    const solPair = { ...SAMPLE_PAIR, baseToken: { address: "MINT_A" } };

    mockFetch.mockResolvedValue(mockResponse([ethPair, solPair]));

    const result = await mod.getDexScreenerBatch({ mints: ["MINT_A"] });
    const pairs = result.get("MINT_A");
    expect(pairs).toHaveLength(1);
    expect(pairs[0].chainId).toBe("solana");
  });

  it("returns empty array for mints with no matching pairs", async () => {
    mockFetch.mockResolvedValue(mockResponse([]));
    const result = await mod.getDexScreenerBatch({ mints: ["UNKNOWN_MINT"] });
    expect(result.get("UNKNOWN_MINT")).toEqual([]);
  });

  it("serves from cache on second call (no fetch)", async () => {
    mockFetch.mockResolvedValue(mockResponse([SAMPLE_PAIR]));
    await mod.getDexScreenerBatch({ mints: ["MINT_A"] });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await mod.getDexScreenerBatch({ mints: ["MINT_A"] });
    expect(mockFetch).toHaveBeenCalledTimes(1); // cached
  });

  it("handles non-ok response gracefully", async () => {
    mockFetch.mockResolvedValue(mockResponse(null, { status: 500 }));
    const result = await mod.getDexScreenerBatch({ mints: ["MINT_A"] });
    expect(result.get("MINT_A")).toBeUndefined();
  });

  it("handles non-array JSON response", async () => {
    mockFetch.mockResolvedValue(mockResponse({ error: "bad" }));
    const result = await mod.getDexScreenerBatch({ mints: ["MINT_A"] });
    expect(result.has("MINT_A")).toBe(false);
  });

  it("mixes cached and uncached mints", async () => {
    // First call caches MINT_A
    mockFetch.mockResolvedValueOnce(mockResponse([SAMPLE_PAIR]));
    await mod.getDexScreenerBatch({ mints: ["MINT_A"] });

    // Second call: MINT_A cached, MINT_B uncached → only fetches MINT_B
    mockFetch.mockResolvedValueOnce(mockResponse([SAMPLE_PAIR_2]));
    const result = await mod.getDexScreenerBatch({ mints: ["MINT_A", "MINT_B"] });

    expect(mockFetch).toHaveBeenCalledTimes(2); // 1 first + 1 second
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("MINT_B")
    );
    expect(result.get("MINT_A")).toHaveLength(1);
    expect(result.get("MINT_B")).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════
// getDexScreenerPairByMint — convenience wrapper
// ══════════════════════════════════════════════════════════════

describe("getDexScreenerPairByMint", () => {
  it("returns null for falsy mint", async () => {
    expect(await mod.getDexScreenerPairByMint({ mint: null })).toBeNull();
    expect(await mod.getDexScreenerPairByMint({ mint: "" })).toBeNull();
  });

  it("returns best pair for a single mint", async () => {
    mockFetch.mockResolvedValue(mockResponse([SAMPLE_PAIR]));
    const result = await mod.getDexScreenerPairByMint({ mint: "MINT_A" });
    expect(result).toEqual(SAMPLE_PAIR);
  });

  it("returns null when no pairs found", async () => {
    mockFetch.mockResolvedValue(mockResponse([]));
    const result = await mod.getDexScreenerPairByMint({ mint: "NOPE" });
    expect(result).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════
// getDexScreenerTokenPairs — legacy single-mint
// ══════════════════════════════════════════════════════════════

describe("getDexScreenerTokenPairs", () => {
  it("returns empty array for falsy mint", async () => {
    expect(await mod.getDexScreenerTokenPairs({ mint: null })).toEqual([]);
  });

  it("fetches and returns sorted Solana pairs", async () => {
    const p1 = { ...SAMPLE_PAIR, volume: { h24: 1000 } };
    const p2 = { ...SAMPLE_PAIR, volume: { h24: 50000 } };
    mockFetch.mockResolvedValue(mockResponse([p1, p2]));

    const result = await mod.getDexScreenerTokenPairs({ mint: "MINT_A" });
    expect(result).toHaveLength(2);
    expect(result[0].volume.h24).toBe(50000); // sorted desc
  });

  it("returns empty array on non-ok response", async () => {
    mockFetch.mockResolvedValue(mockResponse(null, { status: 429 }));
    const result = await mod.getDexScreenerTokenPairs({ mint: "MINT_A" });
    expect(result).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════
// getDexScreenerTrending — with caching
// ══════════════════════════════════════════════════════════════

describe("getDexScreenerTrending", () => {
  it("fetches trending narratives", async () => {
    const trending = [{ name: "AI", volume: 1000000, marketCap: 50000000, tokenCount: 120 }];
    mockFetch.mockResolvedValue(mockResponse(trending));

    const result = await mod.getDexScreenerTrending();
    expect(result).toEqual(trending);
  });

  it("caches results for 15 minutes", async () => {
    const trending = [{ name: "AI", volume: 1000000 }];
    mockFetch.mockResolvedValue(mockResponse(trending));

    await mod.getDexScreenerTrending();
    await mod.getDexScreenerTrending(); // second call
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns stale cache on 429", async () => {
    // First call populates cache
    const trending = [{ name: "AI", volume: 1000000 }];
    mockFetch.mockResolvedValueOnce(mockResponse(trending));
    await mod.getDexScreenerTrending();

    // Second call returns 429
    mockFetch.mockResolvedValueOnce(mockResponse(null, { status: 429 }));
    const result = await mod.getDexScreenerTrending();
    expect(result).toEqual(trending);
  });

  it("returns empty array on first fetch failure", async () => {
    mockFetch.mockResolvedValue(mockResponse(null, { status: 500 }));
    const result = await mod.getDexScreenerTrending();
    expect(result).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════
// formatTrendingForPrompt — formatting
// ══════════════════════════════════════════════════════════════

describe("formatTrendingForPrompt", () => {
  it("returns null when no trending data", async () => {
    mockFetch.mockResolvedValue(mockResponse([]));
    const result = await mod.formatTrendingForPrompt();
    expect(result).toBeNull();
  });

  it("formats narratives with market cap change", async () => {
    const trending = [
      { name: "AI", volume: 500000, marketCap: 50000000, tokenCount: 120, marketCapChange: { h24: 3.2 } },
      { name: "MEMES", volume: 300000, marketCap: 10000000, tokenCount: 80, marketCapChange: { h24: -1.5 } },
    ];
    mockFetch.mockResolvedValue(mockResponse(trending));

    const result = await mod.formatTrendingForPrompt();
    expect(result).toContain("AI");
    expect(result).toContain("+3.2%");
    expect(result).toContain("MEMES");
    expect(result).toContain("-1.5%");
    expect(result).toContain("$50.0M mcap");
    expect(result).toContain("$10.0M mcap");
  });

  it("handles missing marketCapChange", async () => {
    const trending = [
      { name: "UNKNOWN", volume: 100000, marketCap: 1000000, tokenCount: 10 },
    ];
    mockFetch.mockResolvedValue(mockResponse(trending));
    const result = await mod.formatTrendingForPrompt();
    expect(result).toContain("?");
  });

  it("limits to top 8 narratives by volume", async () => {
    clearCaches();
    const trending = Array.from({ length: 15 }, (_, i) => ({
      name: `NARRATIVE_${i}`,
      volume: (i + 1) * 100000,
      marketCap: 1000000,
      tokenCount: 10,
    }));
    mockFetch.mockResolvedValue(mockResponse(trending));
    const result = await mod.formatTrendingForPrompt();
    // Count narratives by splitting on the join pattern between entries
    const narratives = result.split(/\),\s*(?=[A-Z])/);
    expect(narratives).toHaveLength(8);
  });
});

// ══════════════════════════════════════════════════════════════
// getDexScreenerBoosts — with caching
// ══════════════════════════════════════════════════════════════

describe("getDexScreenerBoosts", () => {
  it("fetches and filters Solana boosts only", async () => {
    const boosts = [
      { chainId: "solana", tokenAddress: "MINT_A" },
      { chainId: "ethereum", tokenAddress: "0x123" },
      { chainId: "solana", tokenAddress: "MINT_B" },
    ];
    mockFetch.mockResolvedValue(mockResponse(boosts));

    const result = await mod.getDexScreenerBoosts();
    expect(result).toHaveLength(2);
    expect(result.every((b) => b.chainId === "solana")).toBe(true);
  });

  it("caches results for 15 minutes", async () => {
    mockFetch.mockResolvedValue(mockResponse([{ chainId: "solana", tokenAddress: "X" }]));
    await mod.getDexScreenerBoosts();
    await mod.getDexScreenerBoosts();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns empty array on failure", async () => {
    mockFetch.mockResolvedValue(mockResponse(null, { status: 500 }));
    const result = await mod.getDexScreenerBoosts();
    expect(result).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════
// getRateLimitStatus — counter tracking
// ══════════════════════════════════════════════════════════════

describe("getRateLimitStatus", () => {
  it("returns rate limit info for both buckets", async () => {
    const status = mod.getRateLimitStatus();
    expect(status).toHaveProperty("pair");
    expect(status).toHaveProperty("trending");
    expect(status.pair).toHaveProperty("used");
    expect(status.pair).toHaveProperty("limit");
    expect(status.pair).toHaveProperty("remaining");
    expect(status.pair.limit).toBe(280);
    expect(status.trending.limit).toBe(55);
  });

  it("tracks request count after pair calls", async () => {
    mockFetch.mockResolvedValue(mockResponse({ pairs: [SAMPLE_PAIR] }));
    const before = mod.getRateLimitStatus();
    const beforeCount = before.pair.used;

    await mod.getDexScreenerPair({ pairAddress: "POOL_ADDR_1" });

    const after = mod.getRateLimitStatus();
    expect(after.pair.used).toBe(beforeCount + 1);
  });

  it("tracks request count after batch calls", async () => {
    mockFetch.mockResolvedValue(mockResponse([SAMPLE_PAIR]));
    const before = mod.getRateLimitStatus();

    await mod.getDexScreenerBatch({ mints: ["MINT_A"] });

    const after = mod.getRateLimitStatus();
    expect(after.pair.used).toBe(before.pair.used + 1);
  });
});

// ══════════════════════════════════════════════════════════════
// Retry logic — 429 with exponential backoff
// ══════════════════════════════════════════════════════════════

describe("retry on 429", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries up to 2 times on 429 then gives up", async () => {
    const retryHeaders = { get: (k) => (k === "retry-after" ? "0" : null) };
    const fail429 = { ok: false, status: 429, headers: retryHeaders };

    mockFetch
      .mockResolvedValueOnce(fail429)
      .mockResolvedValueOnce(fail429)
      .mockResolvedValueOnce(fail429);

    const result = await mod.getDexScreenerPair({ pairAddress: "POOL_ADDR_1" });
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("succeeds on retry after initial 429", async () => {
    const retryHeaders = { get: (k) => (k === "retry-after" ? "0" : null) };
    const fail429 = { ok: false, status: 429, headers: retryHeaders };

    mockFetch
      .mockResolvedValueOnce(fail429)
      .mockResolvedValueOnce(mockResponse({ pairs: [SAMPLE_PAIR] }));

    const result = await mod.getDexScreenerPair({ pairAddress: "POOL_ADDR_1" });
    expect(result).toEqual(SAMPLE_PAIR);
    expect(mockFetch).toHaveBeenCalledTimes(2); // 429 then success
  });

  it("retries on network error", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValueOnce(mockResponse({ pairs: [SAMPLE_PAIR] }));

    const result = await mod.getDexScreenerPair({ pairAddress: "POOL_ADDR_1" });
    expect(result).toEqual(SAMPLE_PAIR);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
