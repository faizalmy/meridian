import { describe, it, expect, beforeEach, vi } from "vitest";
import { setupMockFs, seedMockFs, getMockFs, resetMockFs } from "../helpers/mock-fs.js";

setupMockFs();

const STATE_FILE = "./state.json";

let stateMod;
async function loadModule() {
  resetMockFs();
  vi.resetModules();
  stateMod = await import("../../state.js");
}

// Helper: create a management config with low yield settings
function mgmtConfig(overrides = {}) {
  return {
    stopLossPct: -2.0,
    takeProfitPct: 5.0,
    trailingTakeProfit: false,
    trailingTriggerPct: 2.0,
    trailingDropPct: 1.0,
    outOfRangeWaitMinutes: 5,
    minFeePerTvl24h: 30,
    minAgeBeforeYieldCheck: 30,
    ...overrides,
  };
}

describe("updatePnlAndCheckExits — low yield rule", () => {
  beforeEach(async () => {
    await loadModule();
  });

  function trackAndGet(addr = "pos_001") {
    stateMod.trackPosition({
      position: addr,
      pool: "pool_abc",
      pool_name: "TEST-SOL",
      deployed_at: new Date(Date.now() - 40 * 60000).toISOString(), // 40 min ago
    });
    return addr;
  }

  // ── Configurable minAgeBeforeYieldCheck ──────────────────────────────

  it("triggers low yield when age >= minAgeBeforeYieldCheck (configurable)", () => {
    const addr = trackAndGet();
    const config = mgmtConfig({ minAgeBeforeYieldCheck: 30 });

    const result = stateMod.updatePnlAndCheckExits(addr, {
      pnl_pct: -0.5,
      in_range: true,
      fee_per_tvl_24h: 10, // below minFeePerTvl24h of 30
      age_minutes: 35,
    }, config);

    expect(result).not.toBeNull();
    expect(result.action).toBe("LOW_YIELD");
  });

  it("does NOT trigger low yield when age < minAgeBeforeYieldCheck", () => {
    const addr = trackAndGet();
    const config = mgmtConfig({ minAgeBeforeYieldCheck: 30 });

    const result = stateMod.updatePnlAndCheckExits(addr, {
      pnl_pct: -0.5,
      in_range: true,
      fee_per_tvl_24h: 10,
      age_minutes: 20, // below 30 min threshold
    }, config);

    expect(result).toBeNull();
  });

  it("uses default 60 min when minAgeBeforeYieldCheck is not set", () => {
    const addr = trackAndGet();
    const config = mgmtConfig();
    delete config.minAgeBeforeYieldCheck;

    // At 50 min — should NOT trigger (default is 60)
    const result50 = stateMod.updatePnlAndCheckExits(addr, {
      pnl_pct: -0.5,
      in_range: true,
      fee_per_tvl_24h: 10,
      age_minutes: 50,
    }, config);
    expect(result50).toBeNull();

    // At 60 min — SHOULD trigger
    const result60 = stateMod.updatePnlAndCheckExits(addr, {
      pnl_pct: -0.5,
      in_range: true,
      fee_per_tvl_24h: 10,
      age_minutes: 60,
    }, config);
    expect(result60).not.toBeNull();
    expect(result60.action).toBe("LOW_YIELD");
  });

  // ── Fee threshold (minFeePerTvl24h) ─────────────────────────────────

  it("triggers low yield when fee_per_tvl_24h < minFeePerTvl24h", () => {
    const addr = trackAndGet();
    const config = mgmtConfig({ minFeePerTvl24h: 30 });

    const result = stateMod.updatePnlAndCheckExits(addr, {
      pnl_pct: 0.5,
      in_range: true,
      fee_per_tvl_24h: 25, // below 30
      age_minutes: 35,
    }, config);

    expect(result).not.toBeNull();
    expect(result.action).toBe("LOW_YIELD");
    expect(result.reason).toContain("25.00");
    expect(result.reason).toContain("30");
  });

  it("does NOT trigger low yield when fee_per_tvl_24h >= minFeePerTvl24h", () => {
    const addr = trackAndGet();
    const config = mgmtConfig({ minFeePerTvl24h: 30 });

    const result = stateMod.updatePnlAndCheckExits(addr, {
      pnl_pct: 0.5,
      in_range: true,
      fee_per_tvl_24h: 35, // above 30
      age_minutes: 35,
    }, config);

    expect(result).toBeNull();
  });

  // ── Null fee_per_tvl_24h ───────────────────────────────────────────

  it("does NOT trigger when fee_per_tvl_24h is null", () => {
    const addr = trackAndGet();
    const config = mgmtConfig();

    const result = stateMod.updatePnlAndCheckExits(addr, {
      pnl_pct: -0.5,
      in_range: true,
      fee_per_tvl_24h: null,
      age_minutes: 60,
    }, config);

    expect(result).toBeNull();
  });

  it("does NOT trigger when minFeePerTvl24h is null", () => {
    const addr = trackAndGet();
    const config = mgmtConfig({ minFeePerTvl24h: null });

    const result = stateMod.updatePnlAndCheckExits(addr, {
      pnl_pct: -0.5,
      in_range: true,
      fee_per_tvl_24h: 5,
      age_minutes: 60,
    }, config);

    expect(result).toBeNull();
  });

  // ── Null age_minutes ───────────────────────────────────────────────

  it("triggers low yield when age_minutes is null (treated as past threshold)", () => {
    const addr = trackAndGet();
    const config = mgmtConfig({ minAgeBeforeYieldCheck: 30 });

    const result = stateMod.updatePnlAndCheckExits(addr, {
      pnl_pct: -0.5,
      in_range: true,
      fee_per_tvl_24h: 10,
      age_minutes: null,
    }, config);

    // age_minutes == null → age_minutes >= minAgeForYieldCheck → true (null >= 30 is false in JS)
    // Actually: (null == null) is true, so (age_minutes == null || age_minutes >= minAgeForYieldCheck)
    // null == null → true → condition passes
    expect(result).not.toBeNull();
    expect(result.action).toBe("LOW_YIELD");
  });

  // ── Stop loss takes priority over low yield ─────────────────────────

  it("returns STOP_LOSS when PnL is below stop loss (priority over low yield)", () => {
    const addr = trackAndGet();
    const config = mgmtConfig({ stopLossPct: -2.0, minFeePerTvl24h: 30 });

    const result = stateMod.updatePnlAndCheckExits(addr, {
      pnl_pct: -3.0,
      in_range: true,
      fee_per_tvl_24h: 5, // also low yield
      age_minutes: 60,
    }, config);

    expect(result).not.toBeNull();
    expect(result.action).toBe("STOP_LOSS");
  });

  // ── Edge case: exact boundary ───────────────────────────────────────

  it("triggers at exactly minAgeBeforeYieldCheck boundary", () => {
    const addr = trackAndGet();
    const config = mgmtConfig({ minAgeBeforeYieldCheck: 30 });

    // Exactly 30 min
    const result = stateMod.updatePnlAndCheckExits(addr, {
      pnl_pct: 0,
      in_range: true,
      fee_per_tvl_24h: 25,
      age_minutes: 30,
    }, config);

    expect(result).not.toBeNull();
    expect(result.action).toBe("LOW_YIELD");
  });

  it("does NOT trigger 1 minute below minAgeBeforeYieldCheck", () => {
    const addr = trackAndGet();
    const config = mgmtConfig({ minAgeBeforeYieldCheck: 30 });

    const result = stateMod.updatePnlAndCheckExits(addr, {
      pnl_pct: 0,
      in_range: true,
      fee_per_tvl_24h: 25,
      age_minutes: 29,
    }, config);

    expect(result).toBeNull();
  });

  // ── Reason string formatting ────────────────────────────────────────

  it("includes fee/TVL value and min threshold in reason", () => {
    const addr = trackAndGet();
    const config = mgmtConfig({ minFeePerTvl24h: 30 });

    const result = stateMod.updatePnlAndCheckExits(addr, {
      pnl_pct: 0,
      in_range: true,
      fee_per_tvl_24h: 12.34,
      age_minutes: 35,
    }, config);

    expect(result.reason).toContain("12.34");
    expect(result.reason).toContain("30");
    expect(result.reason).toContain("35m");
  });

  // ── Closed position ignored ─────────────────────────────────────────

  it("returns null for closed positions", () => {
    const addr = trackAndGet();
    stateMod.recordClose(addr, "test close");
    const config = mgmtConfig();

    const result = stateMod.updatePnlAndCheckExits(addr, {
      pnl_pct: -5,
      in_range: true,
      fee_per_tvl_24h: 1,
      age_minutes: 120,
    }, config);

    expect(result).toBeNull();
  });
});
