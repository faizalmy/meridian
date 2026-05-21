import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";

// ── Import module (no child_process mock needed) ──────────────
const mod = await import("../../tools/gmgn.js");

// ── Mock fs for cache file operations ─────────────────────────
const CACHE_FILE = path.resolve("gmgn-cache.json");
const originalExistsSync = fs.existsSync;
const originalReadFileSync = fs.readFileSync;
const originalWriteFileSync = fs.writeFileSync;

let mockCacheData = null;

beforeEach(() => {
  mockCacheData = null;
  mod.clearGmgnCaches();
  mod._resetExecFn();

  fs.existsSync = vi.fn((p) => {
    if (p === CACHE_FILE) return mockCacheData !== null;
    return originalExistsSync(p);
  });
  fs.readFileSync = vi.fn((p, enc) => {
    if (p === CACHE_FILE && mockCacheData) return JSON.stringify(mockCacheData);
    return originalReadFileSync(p, enc);
  });
  fs.writeFileSync = vi.fn((p, data) => {
    if (p === CACHE_FILE) {
      mockCacheData = JSON.parse(data);
      return;
    }
    return originalWriteFileSync(p, data);
  });
});

afterEach(() => {
  fs.existsSync = originalExistsSync;
  fs.readFileSync = originalReadFileSync;
  fs.writeFileSync = originalWriteFileSync;
  mod._resetExecFn();
  vi.restoreAllMocks();
});

// ── Helper: inject mock exec function ─────────────────────────
function mockExecImplementation(fn) {
  mod._setExecFn(fn);
}

function mockGmgnOutput(trades) {
  return { stdout: JSON.stringify(trades), stderr: "" };
}

function mockGmgnError(msg) {
  return { stdout: "", stderr: msg };
}

// Sample trade objects matching gmgn-cli --raw output shape
const SAMPLE_SMART_MONEY_TRADE = {
  base_address: "TOKEN_A_MINT",
  maker: "WALLET_1",
  side: "buy",
  usd_amount: "1500",
  timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  is_kol: false,
  is_full_position: false,
};

const SAMPLE_SMART_MONEY_TRADE_2 = {
  base_address: "TOKEN_A_MINT",
  maker: "WALLET_2",
  side: "buy",
  usd_amount: "2000",
  timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  is_kol: false,
  is_full_position: true,
};

const SAMPLE_SMART_MONEY_SELL = {
  base_address: "TOKEN_A_MINT",
  maker: "WALLET_3",
  side: "sell",
  usd_amount: "3000",
  timestamp: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
  is_kol: false,
  is_full_position: true,
};

const SAMPLE_KOL_TRADE = {
  base_address: "TOKEN_B_MINT",
  maker: "KOL_WALLET_1",
  side: "buy",
  usd_amount: "5000",
  timestamp: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
  is_kol: true,
  is_full_position: false,
};

// ══════════════════════════════════════════════════════════════
// fetchSmartMoneyTrades
// ══════════════════════════════════════════════════════════════

describe("fetchSmartMoneyTrades", () => {
  it("returns trade list on success", async () => {
    const trades = [SAMPLE_SMART_MONEY_TRADE, SAMPLE_SMART_MONEY_TRADE_2];
    mockExecImplementation(async () => mockGmgnOutput(trades));

    const result = await mod.fetchSmartMoneyTrades("sol", 10);
    expect(result).toEqual(trades);
  });

  it("returns empty array on gmgn-cli failure (fail-open)", async () => {
    mockExecImplementation(async () => { throw new Error("command not found"); });

    const result = await mod.fetchSmartMoneyTrades("sol", 10);
    expect(result).toEqual([]);
  });

  it("returns empty array on non-JSON output", async () => {
    mockExecImplementation(async () => ({ stdout: "some garbage", stderr: "" }));

    const result = await mod.fetchSmartMoneyTrades("sol", 10);
    expect(result).toEqual([]);
  });

  it("returns cached data on second call (within TTL)", async () => {
    const trades = [SAMPLE_SMART_MONEY_TRADE];
    let callCount = 0;
    mockExecImplementation(async () => {
      callCount++;
      return mockGmgnOutput(trades);
    });

    const result1 = await mod.fetchSmartMoneyTrades("sol", 10);
    const result2 = await mod.fetchSmartMoneyTrades("sol", 10);

    expect(result1).toEqual(trades);
    expect(result2).toEqual(trades);
    expect(callCount).toBe(1); // only one actual call
  });

  it("returns stale cache on rate limit ban", async () => {
    // First call succeeds → populates cache
    const trades = [SAMPLE_SMART_MONEY_TRADE];
    let callCount = 0;
    mockExecImplementation(async () => {
      callCount++;
      if (callCount === 1) return mockGmgnOutput(trades);
      return mockGmgnError("RATE_LIMIT_BANNED reset_at 1234567890");
    });

    await mod.fetchSmartMoneyTrades("sol", 10);
    const result = await mod.fetchSmartMoneyTrades("sol", 10);
    expect(result).toEqual(trades); // stale cache
  });

  it("handles RATE_LIMIT_BANNED with reset_at parsing", async () => {
    mockExecImplementation(async () =>
      mockGmgnError("RATE_LIMIT_BANNED reset_at 1234567890")
    );

    const result = await mod.fetchSmartMoneyTrades("sol", 10);
    expect(result).toEqual([]);

    // Should be banned now
    const state = mod.getCacheState();
    expect(state.bannedUntil).toBeGreaterThan(Date.now());
  });

  it("handles 429 in stderr", async () => {
    mockExecImplementation(async () =>
      mockGmgnError("Error: 429 Too Many Requests")
    );

    const result = await mod.fetchSmartMoneyTrades("sol", 10);
    expect(result).toEqual([]);

    const state = mod.getCacheState();
    expect(state.bannedUntil).toBeGreaterThan(Date.now());
  });

  it("uses default chain='sol' and limit=50", async () => {
    let capturedCmd = "";
    mockExecImplementation(async (cmd) => {
      capturedCmd = cmd;
      return mockGmgnOutput([]);
    });

    await mod.fetchSmartMoneyTrades();
    expect(capturedCmd).toContain("track smartmoney --chain sol --limit 50");
  });
});

// ══════════════════════════════════════════════════════════════
// fetchKolTrades
// ══════════════════════════════════════════════════════════════

describe("fetchKolTrades", () => {
  it("returns KOL trade list on success", async () => {
    const trades = [SAMPLE_KOL_TRADE];
    mockExecImplementation(async () => mockGmgnOutput(trades));

    const result = await mod.fetchKolTrades("sol", 10);
    expect(result).toEqual(trades);
  });

  it("returns empty array on failure (fail-open)", async () => {
    mockExecImplementation(async () => { throw new Error("timeout"); });

    const result = await mod.fetchKolTrades("sol", 10);
    expect(result).toEqual([]);
  });

  it("returns cached data within TTL", async () => {
    const trades = [SAMPLE_KOL_TRADE];
    let callCount = 0;
    mockExecImplementation(async () => {
      callCount++;
      return mockGmgnOutput(trades);
    });

    await mod.fetchKolTrades("sol", 10);
    await mod.fetchKolTrades("sol", 10);

    expect(callCount).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════
// detectClusterSignals
// ══════════════════════════════════════════════════════════════

describe("detectClusterSignals", () => {
  it("returns empty array for null/empty trades", () => {
    expect(mod.detectClusterSignals(null)).toEqual([]);
    expect(mod.detectClusterSignals([])).toEqual([]);
  });

  it("detects weak signal: 1 KOL buy", () => {
    const trades = [
      {
        base_address: "TOKEN_X",
        maker: "KOL_1",
        side: "buy",
        usd_amount: "1000",
        timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        is_kol: true,
        is_full_position: false,
      },
    ];

    const signals = mod.detectClusterSignals(trades);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      token: "TOKEN_X",
      direction: "buy",
      walletCount: 1,
      signalStrength: "weak",
      kolCount: 1,
    });
  });

  it("detects medium signal: 2 smart money buys", () => {
    const trades = [
      {
        base_address: "TOKEN_Y",
        maker: "W_1",
        side: "buy",
        usd_amount: "500",
        timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        is_kol: false,
      },
      {
        base_address: "TOKEN_Y",
        maker: "W_2",
        side: "buy",
        usd_amount: "800",
        timestamp: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
        is_kol: false,
      },
    ];

    const signals = mod.detectClusterSignals(trades);
    expect(signals).toHaveLength(1);
    expect(signals[0].signalStrength).toBe("medium");
    expect(signals[0].walletCount).toBe(2);
  });

  it("detects medium signal: 1 full position open", () => {
    const trades = [
      {
        base_address: "TOKEN_Z",
        maker: "W_1",
        side: "buy",
        usd_amount: "5000",
        timestamp: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
        is_kol: false,
        is_full_position: true,
      },
    ];

    const signals = mod.detectClusterSignals(trades);
    expect(signals).toHaveLength(1);
    expect(signals[0].signalStrength).toBe("medium");
    expect(signals[0].fullPositionCount).toBe(1);
  });

  it("detects strong signal: 3+ smart money same direction", () => {
    const trades = [
      {
        base_address: "TOKEN_W",
        maker: "W_1",
        side: "buy",
        usd_amount: "1000",
        timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      },
      {
        base_address: "TOKEN_W",
        maker: "W_2",
        side: "buy",
        usd_amount: "1500",
        timestamp: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
      },
      {
        base_address: "TOKEN_W",
        maker: "W_3",
        side: "buy",
        usd_amount: "2000",
        timestamp: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
      },
    ];

    const signals = mod.detectClusterSignals(trades);
    expect(signals).toHaveLength(1);
    expect(signals[0].signalStrength).toBe("strong");
    expect(signals[0].walletCount).toBe(3);
  });

  it("detects very_strong signal: cluster + full position + KOL", () => {
    const trades = [
      {
        base_address: "TOKEN_V",
        maker: "W_1",
        side: "buy",
        usd_amount: "1000",
        timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        is_kol: false,
      },
      {
        base_address: "TOKEN_V",
        maker: "W_2",
        side: "buy",
        usd_amount: "1500",
        timestamp: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
        is_kol: false,
        is_full_position: true,
      },
      {
        base_address: "TOKEN_V",
        maker: "W_3",
        side: "buy",
        usd_amount: "2000",
        timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        is_kol: false,
      },
      {
        base_address: "TOKEN_V",
        maker: "KOL_1",
        side: "buy",
        usd_amount: "5000",
        timestamp: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
        is_kol: true,
      },
    ];

    const signals = mod.detectClusterSignals(trades);
    expect(signals).toHaveLength(1);
    expect(signals[0].signalStrength).toBe("very_strong");
    expect(signals[0].walletCount).toBe(4); // 3 smart money + 1 KOL
    expect(signals[0].kolCount).toBe(1);
    expect(signals[0].fullPositionCount).toBe(1);
  });

  it("detects sell signals separately", () => {
    const trades = [
      {
        base_address: "TOKEN_S",
        maker: "W_1",
        side: "sell",
        usd_amount: "1000",
        timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      },
      {
        base_address: "TOKEN_S",
        maker: "W_2",
        side: "sell",
        usd_amount: "1500",
        timestamp: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
      },
    ];

    const signals = mod.detectClusterSignals(trades);
    expect(signals).toHaveLength(1);
    expect(signals[0].direction).toBe("sell");
    expect(signals[0].signalStrength).toBe("medium");
  });

  it("filters trades outside time window", () => {
    const oldTrade = {
      base_address: "TOKEN_OLD",
      maker: "W_1",
      side: "buy",
      usd_amount: "1000",
      timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1 hour ago
    };

    const signals = mod.detectClusterSignals([oldTrade], 30);
    expect(signals).toEqual([]);
  });

  it("handles trades with different field names", () => {
    const trades = [
      {
        token_address: "TOKEN_ALT",
        wallet: "W_1",
        direction: "buy",
        amount_usd: "500",
        created_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      },
      {
        mint: "TOKEN_ALT",
        user_address: "W_2",
        is_buy: true,
        value: "800",
        time: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
      },
    ];

    const signals = mod.detectClusterSignals(trades);
    expect(signals).toHaveLength(1);
    expect(signals[0].token).toBe("TOKEN_ALT");
    expect(signals[0].walletCount).toBe(2);
  });

  it("groups multiple tokens independently", () => {
    const now = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const trades = [
      { base_address: "TOK_A", maker: "W_1", side: "buy", usd_amount: "100", timestamp: now },
      { base_address: "TOK_A", maker: "W_2", side: "buy", usd_amount: "200", timestamp: now },
      { base_address: "TOK_B", maker: "W_3", side: "sell", usd_amount: "300", timestamp: now },
      { base_address: "TOK_B", maker: "W_4", side: "sell", usd_amount: "400", timestamp: now },
    ];

    const signals = mod.detectClusterSignals(trades);
    expect(signals).toHaveLength(2);
    expect(signals.find((s) => s.token === "TOK_A").direction).toBe("buy");
    expect(signals.find((s) => s.token === "TOK_B").direction).toBe("sell");
  });
});

// ══════════════════════════════════════════════════════════════
// checkGmgnSignals
// ══════════════════════════════════════════════════════════════

describe("checkGmgnSignals", () => {
  it("returns empty data for null mint", async () => {
    const result = await mod.checkGmgnSignals(null);
    expect(result).toMatchObject({
      smartMoneyBuys: 0,
      smartMoneySells: 0,
      kolBuys: 0,
      clusterSignal: null,
      recentTrades: [],
    });
  });

  it("aggregates signals from smart money and KOL trades", async () => {
    const now = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const smartTrades = [
      { base_address: "TOKEN_X", maker: "W_1", side: "buy", usd_amount: "1000", timestamp: now },
      { base_address: "TOKEN_X", maker: "W_2", side: "sell", usd_amount: "500", timestamp: now },
      { base_address: "OTHER", maker: "W_3", side: "buy", usd_amount: "2000", timestamp: now },
    ];
    const kolTrades = [
      { base_address: "TOKEN_X", maker: "KOL_1", side: "buy", usd_amount: "3000", timestamp: now, is_kol: true },
    ];

    let callCount = 0;
    mockExecImplementation(async () => {
      callCount++;
      if (callCount === 1) return mockGmgnOutput(smartTrades);
      return mockGmgnOutput(kolTrades);
    });

    const result = await mod.checkGmgnSignals("TOKEN_X");
    expect(result.smartMoneyBuys).toBe(1);
    expect(result.smartMoneySells).toBe(1);
    expect(result.kolBuys).toBe(1);
    expect(result.recentTrades).toHaveLength(3);
  });

  it("returns zero counts when no trades for the mint", async () => {
    mockExecImplementation(async () => mockGmgnOutput([]));

    const result = await mod.checkGmgnSignals("UNKNOWN_MINT");
    expect(result.smartMoneyBuys).toBe(0);
    expect(result.smartMoneySells).toBe(0);
    expect(result.kolBuys).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════
// checkGmgnExitSignal
// ══════════════════════════════════════════════════════════════

describe("checkGmgnExitSignal", () => {
  it("returns no exit signal for null mint", async () => {
    const result = await mod.checkGmgnExitSignal(null);
    expect(result.exitSignal).toBe(false);
    expect(result.walletsSelling).toBe(0);
  });

  it("returns no exit signal when no sells", async () => {
    mockExecImplementation(async () => mockGmgnOutput([]));

    const result = await mod.checkGmgnExitSignal("TOKEN_X");
    expect(result.exitSignal).toBe(false);
    expect(result.walletsSelling).toBe(0);
    expect(result.reason).toContain("No smart money sells");
  });

  it("detects exit signal from full position close", async () => {
    const trades = [
      {
        base_address: "TOKEN_X",
        maker: "W_1",
        side: "sell",
        usd_amount: "5000",
        timestamp: new Date().toISOString(),
        is_full_position: true,
      },
    ];
    mockExecImplementation(async () => mockGmgnOutput(trades));

    const result = await mod.checkGmgnExitSignal("TOKEN_X");
    expect(result.exitSignal).toBe(true);
    expect(result.walletsSelling).toBe(1);
    expect(result.reason).toContain("full position close");
  });

  it("detects exit signal from 3+ wallets selling", async () => {
    const now = new Date().toISOString();
    const trades = [
      { base_address: "TOKEN_X", maker: "W_1", side: "sell", usd_amount: "1000", timestamp: now },
      { base_address: "TOKEN_X", maker: "W_2", side: "sell", usd_amount: "1500", timestamp: now },
      { base_address: "TOKEN_X", maker: "W_3", side: "sell", usd_amount: "2000", timestamp: now },
    ];
    mockExecImplementation(async () => mockGmgnOutput(trades));

    const result = await mod.checkGmgnExitSignal("TOKEN_X");
    expect(result.exitSignal).toBe(true);
    expect(result.walletsSelling).toBe(3);
    expect(result.reason).toContain("simultaneously");
  });

  it("returns no exit signal for 1-2 wallets selling without full close", async () => {
    const now = new Date().toISOString();
    const trades = [
      { base_address: "TOKEN_X", maker: "W_1", side: "sell", usd_amount: "1000", timestamp: now },
      { base_address: "TOKEN_X", maker: "W_2", side: "sell", usd_amount: "1500", timestamp: now },
    ];
    mockExecImplementation(async () => mockGmgnOutput(trades));

    const result = await mod.checkGmgnExitSignal("TOKEN_X");
    expect(result.exitSignal).toBe(false);
    expect(result.walletsSelling).toBe(2);
  });
});

// ══════════════════════════════════════════════════════════════
// clearGmgnCaches
// ══════════════════════════════════════════════════════════════

describe("clearGmgnCaches", () => {
  it("resets all cache and ban state", async () => {
    // Populate cache
    mockExecImplementation(async () => mockGmgnOutput([SAMPLE_SMART_MONEY_TRADE]));
    await mod.fetchSmartMoneyTrades("sol", 10);

    // Clear
    mod.clearGmgnCaches();

    const state = mod.getCacheState();
    expect(state.smartMoneyTrades.trades).toEqual([]);
    expect(state.smartMoneyTrades.lastFetched).toBeNull();
    expect(state.bannedUntil).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════
// Cache file persistence
// ══════════════════════════════════════════════════════════════

describe("cache persistence", () => {
  it("writes cache to disk after successful fetch", async () => {
    mockExecImplementation(async () => mockGmgnOutput([SAMPLE_SMART_MONEY_TRADE]));

    await mod.fetchSmartMoneyTrades("sol", 10);

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      CACHE_FILE,
      expect.any(String)
    );

    const written = JSON.parse(mockCacheData ? JSON.stringify(mockCacheData) : "{}");
    expect(written.smartMoneyTrades).toBeDefined();
    expect(written.smartMoneyTrades.trades).toHaveLength(1);
    expect(written.smartMoneyTrades.lastFetched).toBeTruthy();
  });

  it("loads cache from disk on subsequent calls", async () => {
    // Simulate existing cache on disk
    mockCacheData = {
      smartMoneyTrades: {
        trades: [SAMPLE_SMART_MONEY_TRADE],
        lastFetched: new Date().toISOString(), // fresh
      },
      kolTrades: { trades: [], lastFetched: null },
    };

    let callCount = 0;
    mockExecImplementation(async () => {
      callCount++;
      return mockGmgnOutput([]);
    });

    // Should use cache, not call gmgn-cli
    const result = await mod.fetchSmartMoneyTrades("sol", 10);
    expect(result).toEqual([SAMPLE_SMART_MONEY_TRADE]);
    expect(callCount).toBe(0);
  });
});
