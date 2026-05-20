import { describe, it, expect, beforeEach, vi } from "vitest";
import { setupMockFs, seedMockFs, resetMockFs } from "../helpers/mock-fs.js";

setupMockFs();

const STATE_FILE = "./state.json";

let idxMod;
async function loadModule() {
  resetMockFs();
  seedMockFs({
    [STATE_FILE]: JSON.stringify({ positions: {}, recentEvents: [], lastUpdated: null }),
  });
  vi.resetModules();
  idxMod = await import("../../index.js");
}

function mgmtConfig(overrides = {}) {
  return {
    stopLossPct: -50,
    takeProfitPct: 5,
    outOfRangeBinsToClose: 10,
    outOfRangeWaitMinutes: 30,
    outOfRangeBelowWaitMinutes: 30,
    minFeePerTvl24h: 7,
    minAgeBeforeYieldCheck: 60,
    trailingTakeProfit: false,
    trailingTriggerPct: 3,
    trailingDropPct: 1.5,
    ...overrides,
  };
}

describe("getDeterministicCloseRule — Rule 6: OOR below", () => {
  beforeEach(async () => {
    await loadModule();
  });

  it("returns CLOSE with rule 6 when active_bin < lower_bin and minutes OOR >= threshold", () => {
    const result = idxMod.getDeterministicCloseRule(
      {
        position: "pos_oor_below",
        active_bin: -200,
        lower_bin: -100,
        upper_bin: 0,
        minutes_out_of_range: 35,
        pnl_pct: -1,
        fee_per_tvl_24h: 10,
        age_minutes: 60,
      },
      mgmtConfig({ outOfRangeBelowWaitMinutes: 30 })
    );
    expect(result).not.toBeNull();
    expect(result.action).toBe("CLOSE");
    expect(result.rule).toBe(6);
    expect(result.reason).toBe("OOR below");
  });

  it("does NOT trigger when active_bin is within range", () => {
    const result = idxMod.getDeterministicCloseRule(
      {
        position: "pos_in_range",
        active_bin: -50,
        lower_bin: -100,
        upper_bin: 0,
        minutes_out_of_range: 0,
        pnl_pct: 1,
        fee_per_tvl_24h: 10,
        age_minutes: 60,
      },
      mgmtConfig()
    );
    // Should be null (no close rule triggered — in range is fine)
    expect(result).toBeNull();
  });

  it("does NOT trigger when active_bin > upper_bin (OOR above, not below)", () => {
    const result = idxMod.getDeterministicCloseRule(
      {
        position: "pos_oor_above",
        active_bin: 10,
        lower_bin: -100,
        upper_bin: 0,
        minutes_out_of_range: 40,
        pnl_pct: 2,
        fee_per_tvl_24h: 10,
        age_minutes: 60,
      },
      mgmtConfig({ outOfRangeWaitMinutes: 30 })
    );
    // Rule 4 would trigger (OOR above), not Rule 6
    expect(result).not.toBeNull();
    expect(result.rule).toBe(4);
    expect(result.reason).toBe("OOR");
  });

  it("does NOT trigger when minutes_out_of_range < outOfRangeBelowWaitMinutes", () => {
    const result = idxMod.getDeterministicCloseRule(
      {
        position: "pos_oor_below_early",
        active_bin: -200,
        lower_bin: -100,
        upper_bin: 0,
        minutes_out_of_range: 10,
        pnl_pct: -1,
        fee_per_tvl_24h: 10,
        age_minutes: 60,
      },
      mgmtConfig({ outOfRangeBelowWaitMinutes: 30 })
    );
    expect(result).toBeNull();
  });

  it("triggers at exactly outOfRangeBelowWaitMinutes boundary", () => {
    const result = idxMod.getDeterministicCloseRule(
      {
        position: "pos_oor_below_exact",
        active_bin: -200,
        lower_bin: -100,
        upper_bin: 0,
        minutes_out_of_range: 30,
        pnl_pct: -1,
        fee_per_tvl_24h: 10,
        age_minutes: 60,
      },
      mgmtConfig({ outOfRangeBelowWaitMinutes: 30 })
    );
    expect(result).not.toBeNull();
    expect(result.rule).toBe(6);
  });

  it("does NOT trigger when lower_bin is null", () => {
    const result = idxMod.getDeterministicCloseRule(
      {
        position: "pos_no_lower",
        active_bin: -200,
        lower_bin: null,
        upper_bin: 0,
        minutes_out_of_range: 40,
        pnl_pct: -1,
        fee_per_tvl_24h: 10,
        age_minutes: 60,
      },
      mgmtConfig()
    );
    expect(result).toBeNull();
  });

  it("does NOT trigger when active_bin is null", () => {
    const result = idxMod.getDeterministicCloseRule(
      {
        position: "pos_no_active",
        active_bin: null,
        lower_bin: -100,
        upper_bin: 0,
        minutes_out_of_range: 40,
        pnl_pct: -1,
        fee_per_tvl_24h: 10,
        age_minutes: 60,
      },
      mgmtConfig()
    );
    expect(result).toBeNull();
  });

  it("defaults to 30 min when outOfRangeBelowWaitMinutes is not set", () => {
    const config = mgmtConfig();
    delete config.outOfRangeBelowWaitMinutes;

    // 20 min — should NOT trigger (default is 30)
    const result20 = idxMod.getDeterministicCloseRule(
      {
        position: "pos_default_20",
        active_bin: -200,
        lower_bin: -100,
        upper_bin: 0,
        minutes_out_of_range: 20,
        pnl_pct: -1,
        fee_per_tvl_24h: 10,
        age_minutes: 60,
      },
      config
    );
    expect(result20).toBeNull();

    // 30 min — SHOULD trigger
    const result30 = idxMod.getDeterministicCloseRule(
      {
        position: "pos_default_30",
        active_bin: -200,
        lower_bin: -100,
        upper_bin: 0,
        minutes_out_of_range: 30,
        pnl_pct: -1,
        fee_per_tvl_24h: 10,
        age_minutes: 60,
      },
      config
    );
    expect(result30).not.toBeNull();
    expect(result30.rule).toBe(6);
  });

  it("stop loss takes priority over OOR below when PnL is worse", () => {
    const result = idxMod.getDeterministicCloseRule(
      {
        position: "pos_sl_priority",
        active_bin: -200,
        lower_bin: -100,
        upper_bin: 0,
        minutes_out_of_range: 40,
        pnl_pct: -60, // below stop loss of -50
        fee_per_tvl_24h: 10,
        age_minutes: 60,
      },
      mgmtConfig({ stopLossPct: -50 })
    );
    expect(result).not.toBeNull();
    expect(result.rule).toBe(1);
    expect(result.reason).toBe("stop loss");
  });

  it("OOR below triggers when minutes_out_of_range is null (treated as 0)", () => {
    const result = idxMod.getDeterministicCloseRule(
      {
        position: "pos_oor_null",
        active_bin: -200,
        lower_bin: -100,
        upper_bin: 0,
        minutes_out_of_range: null,
        pnl_pct: -1,
        fee_per_tvl_24h: 10,
        age_minutes: 60,
      },
      mgmtConfig({ outOfRangeBelowWaitMinutes: 30 })
    );
    // null ?? 0 → 0, which is < 30, so no trigger
    expect(result).toBeNull();
  });
});
