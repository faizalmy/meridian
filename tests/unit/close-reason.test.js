import { describe, it, expect } from "vitest";
import { normalizeCloseReason } from "../../close-reason.js";

describe("normalizeCloseReason", () => {
  // Stop loss variants
  it("categorizes stop loss reasons", () => {
    expect(normalizeCloseReason("stop loss")).toBe("stop_loss");
    expect(normalizeCloseReason("Stop loss: PnL -3.12% <= -3%")).toBe("stop_loss");
    expect(normalizeCloseReason("Stop loss triggered: PnL -2.06% <= -2% threshold")).toBe("stop_loss");
    expect(normalizeCloseReason("stop loss — trailing TP: PnL -3.28%")).toBe("stop_loss");
    expect(normalizeCloseReason("CLOSE — Stop loss rule triggered: PnL -2.01% <= -2% threshold. Trailing TP stop loss exit.")).toBe("stop_loss");
    expect(normalizeCloseReason("Trailing TP stop loss triggered: PnL -4.00% <= -4% threshold")).toBe("stop_loss");
    expect(normalizeCloseReason("Trailing TP: Stop loss triggered — PnL -3.04% <= -3% threshold")).toBe("stop_loss");
    expect(normalizeCloseReason("⚡ Trailing TP stop loss: PnL -2.68% <= -2.5%")).toBe("stop_loss");
  });

  // Take profit variants
  it("categorizes take profit reasons", () => {
    expect(normalizeCloseReason("take profit")).toBe("take_profit");
    expect(normalizeCloseReason("take profit: PnL 3.15% >= 3%")).toBe("take_profit");
    expect(normalizeCloseReason("Rule 2: take profit — PnL +4.17% exceeds takeProfitPct 4%")).toBe("take_profit");
    expect(normalizeCloseReason("Take profit: PnL +8.26% exceeds 8% threshold (Rule 2)")).toBe("take_profit");
  });

  // Trailing TP variants (not stop loss)
  it("categorizes trailing TP reasons", () => {
    expect(normalizeCloseReason("Trailing TP: peak 3.16% → current 1.42% (dropped 1.74% >= 1%)")).toBe("trailing_tp");
    expect(normalizeCloseReason("⚡ Trailing TP: peak 2.87% → current 1.09% (dropped 1.78% >= 1.5%)")).toBe("trailing_tp");
    expect(normalizeCloseReason("Trailing TP triggered: peak 3.42% → current 1.88% (dropped 1.54% >= 1.5%)")).toBe("trailing_tp");
  });

  // OOR Above (Rule 3 — pumped)
  it("categorizes OOR above reasons", () => {
    expect(normalizeCloseReason("Rule 3: pumped far above range")).toBe("oor_above");
    expect(normalizeCloseReason("Rule 3: pumped far above range — active bin -581, position bins -662 to -593, price moved above upper range")).toBe("oor_above");
    expect(normalizeCloseReason("CLOSE — Rule 3: pumped far above range. Active bin -521 above upper bin -532")).toBe("oor_above");
  });

  // OOR Below (Rule 6)
  it("categorizes OOR below reasons", () => {
    expect(normalizeCloseReason("OOR below")).toBe("oor_below");
    expect(normalizeCloseReason("oor below — price dropped")).toBe("oor_below");
  });

  // OOR generic (Rule 4 — timed out)
  it("categorizes generic OOR reasons", () => {
    expect(normalizeCloseReason("OOR")).toBe("oor");
    expect(normalizeCloseReason("Out of range for 30m (limit: 30m)")).toBe("oor");
    expect(normalizeCloseReason("Out of range for 5m (limit: 5m)")).toBe("oor");
    expect(normalizeCloseReason("⚡ Trailing TP: Out of range for 30m (limit: 30m) — exit alert triggered")).toBe("oor");
    expect(normalizeCloseReason("Trailing TP trigger — out of range for 5m (limit 5m)")).toBe("oor");
    expect(normalizeCloseReason("OOR for 5m (limit 5m) — PnL -1.47%")).toBe("oor");
  });

  // Low yield (Rule 5)
  it("categorizes low yield reasons", () => {
    expect(normalizeCloseReason("Low yield: fee/TVL 2.11% < min 10% (age: 60m)")).toBe("low_yield");
    expect(normalizeCloseReason("⚡ Trailing TP: Low yield: fee/TVL 1.05% < min 10% (age: 60m)")).toBe("low_yield");
    expect(normalizeCloseReason("Low yield — fee/TVL 5.38% < min 10% threshold (age: 60m)")).toBe("low_yield");
  });

  // Agent decision
  it("categorizes agent decision", () => {
    expect(normalizeCloseReason("agent decision")).toBe("agent");
    expect(normalizeCloseReason("Agent chose to close")).toBe("agent");
  });

  // Manual / user requested
  it("categorizes manual closes", () => {
    expect(normalizeCloseReason("User requested to close all positions and stop the bot")).toBe("manual");
    expect(normalizeCloseReason("manual close")).toBe("manual");
  });

  // Edge cases
  it("handles null/undefined/empty", () => {
    expect(normalizeCloseReason(null)).toBe("unknown");
    expect(normalizeCloseReason(undefined)).toBe("unknown");
    expect(normalizeCloseReason("")).toBe("unknown");
  });

  it("is case-insensitive", () => {
    expect(normalizeCloseReason("STOP LOSS")).toBe("stop_loss");
    expect(normalizeCloseReason("Take Profit")).toBe("take_profit");
    expect(normalizeCloseReason("LOW YIELD")).toBe("low_yield");
  });
});
