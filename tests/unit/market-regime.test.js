import { describe, it, expect, beforeEach, vi } from "vitest";
import { setupMockFs, seedMockFs, resetMockFs } from "../helpers/mock-fs.js";

setupMockFs();

const STATE_FILE = "./state.json";

let idxMod;
let config;
async function loadModule() {
  resetMockFs();
  seedMockFs({
    [STATE_FILE]: JSON.stringify({ positions: {}, recentEvents: [], lastUpdated: null }),
  });
  vi.resetModules();
  const configMod = await import("../../config.js");
  config = configMod.config;
  idxMod = await import("../../index.js");
}

describe("checkMarketRegime", () => {
  beforeEach(async () => {
    await loadModule();
    vi.restoreAllMocks();
  });

  it("returns NORMAL when marketRegime is disabled", async () => {
    // Default config has marketRegime.enabled = false
    const result = await idxMod.checkMarketRegime();
    expect(result.regime).toBe("NORMAL");
    expect(result.reason).toBe("disabled");
  });

  it("returns NORMAL when CoinGecko returns positive 24h change", async () => {
    config.marketRegime.enabled = true;
    config.marketRegime.bearishThreshold = -5;
    config.marketRegime.extremeBearishThreshold = -10;
    config.marketRegime.solPriceCacheTtlMs = 0;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        solana: { usd: 150, usd_24h_change: 2.5 },
      }),
    });

    const result = await idxMod.checkMarketRegime();
    expect(result.regime).toBe("NORMAL");
    expect(result.change24h).toBe(2.5);
  });

  it("returns BEARISH when SOL drops >5%", async () => {
    config.marketRegime.enabled = true;
    config.marketRegime.bearishThreshold = -5;
    config.marketRegime.extremeBearishThreshold = -10;
    config.marketRegime.solPriceCacheTtlMs = 0;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        solana: { usd: 130, usd_24h_change: -6.2 },
      }),
    });

    const result = await idxMod.checkMarketRegime();
    expect(result.regime).toBe("BEARISH");
    expect(result.change24h).toBe(-6.2);
  });

  it("returns EXTREME_BEARISH when SOL drops >10%", async () => {
    config.marketRegime.enabled = true;
    config.marketRegime.bearishThreshold = -5;
    config.marketRegime.extremeBearishThreshold = -10;
    config.marketRegime.solPriceCacheTtlMs = 0;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        solana: { usd: 115, usd_24h_change: -12.8 },
      }),
    });

    const result = await idxMod.checkMarketRegime();
    expect(result.regime).toBe("EXTREME_BEARISH");
    expect(result.change24h).toBe(-12.8);
  });

  it("returns NORMAL on API failure (fail-open)", async () => {
    config.marketRegime.enabled = true;
    config.marketRegime.solPriceCacheTtlMs = 0;

    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network timeout"));

    const result = await idxMod.checkMarketRegime();
    expect(result.regime).toBe("NORMAL");
    expect(result.reason).toContain("api_error");
  });

  it("returns NORMAL when usd_24h_change is null", async () => {
    config.marketRegime.enabled = true;
    config.marketRegime.solPriceCacheTtlMs = 0;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        solana: { usd: 150, usd_24h_change: null },
      }),
    });

    const result = await idxMod.checkMarketRegime();
    expect(result.regime).toBe("NORMAL");
    expect(result.reason).toBe("no_change_data");
  });

  it("caches results within TTL", async () => {
    config.marketRegime.enabled = true;
    config.marketRegime.bearishThreshold = -5;
    config.marketRegime.extremeBearishThreshold = -10;
    config.marketRegime.solPriceCacheTtlMs = 300000;

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        solana: { usd: 150, usd_24h_change: -6 },
      }),
    });
    globalThis.fetch = mockFetch;

    const result1 = await idxMod.checkMarketRegime();
    expect(result1.regime).toBe("BEARISH");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const result2 = await idxMod.checkMarketRegime();
    expect(result2.regime).toBe("BEARISH");
    expect(mockFetch).toHaveBeenCalledTimes(1); // still 1 — cached
  });

  it("returns NORMAL when HTTP status is not ok", async () => {
    config.marketRegime.enabled = true;
    config.marketRegime.solPriceCacheTtlMs = 0;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
    });

    const result = await idxMod.checkMarketRegime();
    expect(result.regime).toBe("NORMAL");
    expect(result.reason).toContain("api_error");
  });
});
