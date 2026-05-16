import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── All exports from telegram-formatter.js ──────────────────────
import {
  bold, code, italic, escapeHtml,
  formatAge, formatUSD, formatSOL, formatPct, formatPrice,
  buildRangeBar,
  formatManagementReport, formatScreeningReport,
  formatDeployNotification, formatCloseNotification,
  parseDecision,
} from "../../telegram-formatter.js";

// ─── HTML Helpers ────────────────────────────────────────────────

describe("bold", () => {
  it("wraps text in <b> tags", () => {
    expect(bold("hello")).toBe("<b>hello</b>");
  });
  it("handles empty string", () => {
    expect(bold("")).toBe("<b></b>");
  });
  it("handles special chars", () => {
    expect(bold("<test>")).toBe("<b><test></b>");
  });
});

describe("code", () => {
  it("wraps text in <code> tags", () => {
    expect(code("x = 1")).toBe("<code>x = 1</code>");
  });
  it("handles empty string", () => {
    expect(code("")).toBe("<code></code>");
  });
});

describe("italic", () => {
  it("wraps text in <i> tags", () => {
    expect(italic("emphasis")).toBe("<i>emphasis</i>");
  });
});

describe("escapeHtml", () => {
  it("escapes < and > to prevent HTML tag injection", () => {
    expect(escapeHtml("PnL <= -2%")).toBe("PnL &lt;= -2%");
  });
  it("escapes ampersand", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });
  it("leaves clean text unchanged", () => {
    expect(escapeHtml("stop loss triggered")).toBe("stop loss triggered");
  });
  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });
});

// ─── Data Formatting ─────────────────────────────────────────────

describe("formatAge", () => {
  it("returns ? for null", () => {
    expect(formatAge(null)).toBe("?");
  });
  it("returns ? for undefined", () => {
    expect(formatAge(undefined)).toBe("?");
  });
  it("formats minutes only when < 60", () => {
    expect(formatAge(45)).toBe("45m");
  });
  it("formats hours when >= 60", () => {
    expect(formatAge(120)).toBe("2h");
  });
  it("formats hours and minutes", () => {
    expect(formatAge(90)).toBe("1h 30m");
  });
  it("handles zero", () => {
    expect(formatAge(0)).toBe("0m");
  });
  it("handles exactly 60 minutes", () => {
    expect(formatAge(60)).toBe("1h");
  });
});

describe("formatUSD", () => {
  it("returns ? for null", () => {
    expect(formatUSD(null)).toBe("?");
  });
  it("returns ? for undefined", () => {
    expect(formatUSD(undefined)).toBe("?");
  });
  it("formats with 2 decimal places", () => {
    expect(formatUSD(1234.5)).toBe("$1,234.50");
  });
  it("formats zero", () => {
    expect(formatUSD(0)).toBe("$0.00");
  });
  it("formats negative values", () => {
    expect(formatUSD(-42.1)).toBe("$-42.10");
  });
  it("formats large numbers with commas", () => {
    expect(formatUSD(1000000)).toBe("$1,000,000.00");
  });
});

describe("formatSOL", () => {
  it("returns ? for null", () => {
    expect(formatSOL(null)).toBe("?");
  });
  it("returns ? for undefined", () => {
    expect(formatSOL(undefined)).toBe("?");
  });
  it("formats with 4 decimal places", () => {
    expect(formatSOL(1.23456)).toBe("1.2346 SOL");
  });
  it("formats zero", () => {
    expect(formatSOL(0)).toBe("0.0000 SOL");
  });
});

describe("formatPct", () => {
  it("returns ? for null", () => {
    expect(formatPct(null)).toBe("?");
  });
  it("returns ? for undefined", () => {
    expect(formatPct(undefined)).toBe("?");
  });
  it("shows + sign for positive by default", () => {
    expect(formatPct(5.123)).toBe("+5.12%");
  });
  it("shows no sign for negative", () => {
    expect(formatPct(-3.45)).toBe("-3.45%");
  });
  it("shows + for zero by default", () => {
    expect(formatPct(0)).toBe("+0.00%");
  });
  it("hides sign when showSign=false", () => {
    expect(formatPct(5, false)).toBe("5.00%");
  });
  it("hides sign for negative when showSign=false", () => {
    expect(formatPct(-3, false)).toBe("-3.00%");
  });
});

describe("formatPrice", () => {
  it("returns ? for null", () => {
    expect(formatPrice(null)).toBe("?");
  });
  it("returns ? for undefined", () => {
    expect(formatPrice(undefined)).toBe("?");
  });
  it("uses exponential for very small prices", () => {
    expect(formatPrice(0.0000123)).toMatch(/1\.230e-5/);
  });
  it("uses toFixed for normal prices", () => {
    expect(formatPrice(0.123456)).toBe("0.123456");
  });
  it("handles exactly 0.0001 boundary", () => {
    // 0.0001 is NOT < 0.0001, so should use toFixed
    expect(formatPrice(0.0001)).toBe("0.000100");
  });
  it("handles prices just below boundary", () => {
    expect(formatPrice(0.0000999)).toMatch(/e/);
  });
});

// ─── Progress Bar ────────────────────────────────────────────────

describe("buildRangeBar", () => {
  it("returns null when bins are missing", () => {
    expect(buildRangeBar({})).toBe(null);
    expect(buildRangeBar({ lower_bin: 0 })).toBe(null);
  });
  it("returns null when range is zero or negative", () => {
    expect(buildRangeBar({ lower_bin: 10, upper_bin: 10, active_bin: 10 })).toBe(null);
    expect(buildRangeBar({ lower_bin: 10, upper_bin: 5, active_bin: 7 })).toBe(null);
  });
  it("renders in-range bar with correct fill ratio", () => {
    const bar = buildRangeBar({ lower_bin: 0, upper_bin: 10, active_bin: 5, in_range: true });
    expect(bar).toContain("<code>");
    expect(bar).toContain("▓");
    expect(bar).toContain("░");
  });
  it("renders out-of-range low indicator", () => {
    const bar = buildRangeBar({ lower_bin: 5, upper_bin: 10, active_bin: 2, in_range: false });
    expect(bar).toContain("◀");
  });
  it("renders out-of-range high indicator", () => {
    const bar = buildRangeBar({ lower_bin: 0, upper_bin: 5, active_bin: 8, in_range: false });
    expect(bar).toContain("▶");
  });
  it("includes percentage range when bin_step provided", () => {
    const bar = buildRangeBar({
      lower_bin: -10, upper_bin: 10, active_bin: 0,
      in_range: true, bin_step: 100,
    });
    expect(bar).toContain("%");
    expect(bar).toContain("/");
  });
  it("uses custom width", () => {
    const bar = buildRangeBar({ lower_bin: 0, upper_bin: 10, active_bin: 5, in_range: true }, 5);
    expect(bar).toContain("<code>");
  });
});

// ─── Management Report ───────────────────────────────────────────

describe("formatManagementReport", () => {
  const makePos = (overrides = {}) => ({
    position: "pos1",
    pair: "BONK-SOL",
    in_range: true,
    age_minutes: 120,
    total_value_usd: 45.67,
    unclaimed_fees_usd: 0.34,
    pnl_usd: 2.15,
    pnl_pct: 4.92,
    fee_per_tvl_24h: 12.5,
    ...overrides,
  });

  const defaultPortfolio = {
    totalValue: 100.5,
    totalUnclaimed: 1.23,
    solMode: false,
  };

  it("formats a single position with all fields", () => {
    const positions = [makePos()];
    const actionMap = new Map([["pos1", { action: "STAY" }]]);
    const msg = formatManagementReport(positions, actionMap, defaultPortfolio);

    expect(msg).toContain("<b>BONK-SOL</b>");
    expect(msg).toContain("Age: 2h");
    expect(msg).toContain("$45.67");
    expect(msg).toContain("PnL:");
    expect(msg).toContain("4.92%");
    expect(msg).toContain("🟢 IN");
    expect(msg).toContain("Summary:");
    expect(msg).toContain("1 positions");
  });

  it("shows OOR with minutes", () => {
    const positions = [makePos({ in_range: false, minutes_out_of_range: 30 })];
    const actionMap = new Map([["pos1", { action: "STAY" }]]);
    const msg = formatManagementReport(positions, actionMap, defaultPortfolio);

    expect(msg).toContain("🔴 OOR 30m");
  });

  it("shows HOLD for INSTRUCTION action", () => {
    const positions = [makePos()];
    const actionMap = new Map([["pos1", { action: "INSTRUCTION" }]]);
    const msg = formatManagementReport(positions, actionMap, defaultPortfolio);

    expect(msg).toContain("HOLD (instruction)");
  });

  it("shows CLOSE with trailing TP reason", () => {
    const positions = [makePos()];
    const reason = "Trailing TP: peak 5.00% → current 3.50% (dropped 1.50% >= 1.5%)";
    const actionMap = new Map([["pos1", { action: "CLOSE", rule: "exit", reason }]]);
    const msg = formatManagementReport(positions, actionMap, defaultPortfolio);

    expect(msg).toContain("⚡ Trailing TP: Trailing TP: peak");
  });

  it("shows CLOSE with non-exit rule", () => {
    const positions = [makePos()];
    const actionMap = new Map([["pos1", { action: "CLOSE", rule: "stop_loss", reason: "hit SL" }]]);
    const msg = formatManagementReport(positions, actionMap, defaultPortfolio);

    expect(msg).toContain("Rule stop_loss: hit SL");
  });

  it("escapes HTML in close reason (<= stop loss)", () => {
    const positions = [makePos()];
    const actionMap = new Map([["pos1", { action: "CLOSE", rule: "exit", reason: "Stop loss: PnL -2.32% <= -2%" }]]);
    const msg = formatManagementReport(positions, actionMap, defaultPortfolio);

    expect(msg).toContain("Stop loss: PnL -2.32% &lt;= -2%");
    expect(msg).not.toContain("Stop loss: PnL -2.32% <=");
  });

  it("escapes HTML in non-exit close reason", () => {
    const positions = [makePos()];
    const actionMap = new Map([["pos1", { action: "CLOSE", rule: 1, reason: "pnl <= stopLoss" }]]);
    const msg = formatManagementReport(positions, actionMap, defaultPortfolio);

    expect(msg).toContain("Rule 1: pnl &lt;= stopLoss");
  });

  it("shows CLAIM action", () => {
    const positions = [makePos()];
    const actionMap = new Map([["pos1", { action: "CLAIM" }]]);
    const msg = formatManagementReport(positions, actionMap, defaultPortfolio);

    expect(msg).toContain("→ Claiming fees");
  });

  it("shows instruction note when present", () => {
    const positions = [makePos({ instruction: "wait for pump" })];
    const actionMap = new Map([["pos1", { action: "STAY" }]]);
    const msg = formatManagementReport(positions, actionMap, defaultPortfolio);

    expect(msg).toContain('Note: "wait for pump"');
  });

  it("escapes HTML in action summary reason", () => {
    const positions = [makePos()];
    const actionMap = new Map([["pos1", { action: "CLOSE", rule: "exit", reason: "PnL <= -2%" }]]);
    const msg = formatManagementReport(positions, actionMap, defaultPortfolio);

    expect(msg).toContain("Summary:");
    expect(msg).toContain("CLOSE (PnL &lt;= -2%)");
    expect(msg).not.toContain("CLOSE (PnL <= -2%)");
  });

  it("uses SOL symbols when solMode=true", () => {
    const positions = [makePos()];
    const actionMap = new Map([["pos1", { action: "STAY" }]]);
    const msg = formatManagementReport(positions, actionMap, {
      ...defaultPortfolio,
      solMode: true,
      totalValue: 0.5,
      totalUnclaimed: 0.005,
    });

    expect(msg).toContain("◎");
  });

  it("handles negative PnL", () => {
    const positions = [makePos({ pnl_usd: -3.2, pnl_pct: -7.1 })];
    const actionMap = new Map([["pos1", { action: "STAY" }]]);
    const msg = formatManagementReport(positions, actionMap, defaultPortfolio);

    expect(msg).toContain("-$3.20");
  });

  it("handles multiple positions", () => {
    const positions = [
      makePos({ position: "p1", pair: "A-SOL" }),
      makePos({ position: "p2", pair: "B-SOL" }),
    ];
    const actionMap = new Map([
      ["p1", { action: "STAY" }],
      ["p2", { action: "STAY" }],
    ]);
    const msg = formatManagementReport(positions, actionMap, defaultPortfolio);

    expect(msg).toContain("<b>A-SOL</b>");
    expect(msg).toContain("<b>B-SOL</b>");
    expect(msg).toContain("2 positions");
  });

  it("summaries actions in footer", () => {
    const positions = [makePos()];
    const actionMap = new Map([["pos1", { action: "CLOSE", reason: "SL" }]]);
    const msg = formatManagementReport(positions, actionMap, defaultPortfolio);

    expect(msg).toContain("CLOSE");
  });

  it("shows 'no action' when all STAY", () => {
    const positions = [makePos()];
    const actionMap = new Map([["pos1", { action: "STAY" }]]);
    const msg = formatManagementReport(positions, actionMap, defaultPortfolio);

    expect(msg).toContain("no action");
  });

  it("includes range bar when bins available", () => {
    const positions = [makePos({
      lower_bin: 0, upper_bin: 10, active_bin: 5, in_range: true, bin_step: 100,
    })];
    const actionMap = new Map([["pos1", { action: "STAY" }]]);
    const msg = formatManagementReport(positions, actionMap, defaultPortfolio);

    expect(msg).toContain("▓");
  });

  it("handles null pnl_usd gracefully", () => {
    const positions = [makePos({ pnl_usd: null, pnl_pct: null })];
    const actionMap = new Map([["pos1", { action: "STAY" }]]);
    const msg = formatManagementReport(positions, actionMap, defaultPortfolio);

    expect(msg).toContain("PnL: ?");
  });
});

// ─── Screening Report ────────────────────────────────────────────

describe("formatScreeningReport", () => {
  const makeCandidate = (name, overrides = {}) => ({
    pool: { name, risk_level: 1, is_rugpull: false, is_wash: false, token_age_hours: 2, ...overrides },
    sw: { in_pool: [{ addr: "w1" }] },
    ti: { holders: 150 },
    ...overrides,
  });

  const defaultPortfolio = { totalValue: 50, totalUnclaimed: 0.5, solMode: false };

  it("formats deploy decision", () => {
    const candidates = [makeCandidate("BONK-SOL")];
    const decision = {
      action: "deploy",
      pair: "BONK-SOL",
      confidence: "high",
      summary: "Good metrics, smart money present",
    };
    const msg = formatScreeningReport(candidates, decision, defaultPortfolio);

    expect(msg).toContain("<b>🔍 Screening Complete</b>");
    expect(msg).toContain("<b>🚀 Deploy:</b> BONK-SOL");
    expect(msg).toContain("🟢 HIGH");
    expect(msg).toContain("Good metrics");
    expect(msg).toContain("Token age: 2h");
    expect(msg).toContain("Holders: 150");
    expect(msg).toContain("1 wallets present");
    expect(msg).toContain("Rugpull: NO");
    expect(msg).toContain("Wash: NO");
  });

  it("formats skip decision", () => {
    const candidates = [
      makeCandidate("SCAM-SOL", { skipReason: "failed rugpull filter" }),
    ];
    const decision = { action: "skip", reason: "All candidates rejected" };
    const msg = formatScreeningReport(candidates, decision, defaultPortfolio);

    expect(msg).toContain("<b>⛔ No Deploy</b>");
    expect(msg).toContain("All candidates rejected");
    expect(msg).toContain("SCAM-SOL: failed rugpull filter");
  });

  it("formats skip with no candidates", () => {
    const decision = { action: "skip", reason: "No candidates" };
    const msg = formatScreeningReport([], decision, defaultPortfolio);

    expect(msg).toContain("No candidates");
    expect(msg).not.toContain("Rejected:");
  });

  it("handles all confidence levels", () => {
    const levels = [
      ["very_high", "🟢🟢 VERY HIGH"],
      ["high", "🟢 HIGH"],
      ["medium_high", "🟡🟢 MEDIUM-HIGH"],
      ["medium", "🟡 MEDIUM"],
      ["medium_low", "🟠🟡 MEDIUM-LOW"],
      ["low", "🔴 LOW"],
      ["very_low", "🔴🔴 VERY LOW"],
    ];

    for (const [level, expected] of levels) {
      const candidates = [makeCandidate("X-SOL")];
      const decision = { action: "deploy", pair: "X-SOL", confidence: level, summary: "test" };
      const msg = formatScreeningReport(candidates, decision, defaultPortfolio);
      expect(msg).toContain(expected);
    }
  });

  it("handles unknown confidence level (falls back to medium)", () => {
    const candidates = [makeCandidate("X-SOL")];
    const decision = { action: "deploy", pair: "X-SOL", confidence: "bogus", summary: "test" };
    const msg = formatScreeningReport(candidates, decision, defaultPortfolio);
    expect(msg).toContain("🟡 MEDIUM");
  });

  it("shows no smart money when sw.in_pool is empty", () => {
    const candidates = [{ ...makeCandidate("X-SOL"), sw: { in_pool: [] } }];
    const decision = { action: "deploy", pair: "X-SOL", confidence: "medium", summary: "test" };
    const msg = formatScreeningReport(candidates, decision, defaultPortfolio);
    expect(msg).toContain("none");
  });

  it("handles deploy when candidate not found", () => {
    const decision = { action: "deploy", pair: "GHOST-SOL", confidence: "high", summary: "test" };
    const msg = formatScreeningReport([], decision, defaultPortfolio);
    expect(msg).toContain("no data available");
  });

  it("formats rugpull flagged pool", () => {
    const candidates = [makeCandidate("RUG-SOL", { is_rugpull: true })];
    const decision = { action: "deploy", pair: "RUG-SOL", confidence: "low", summary: "test" };
    const msg = formatScreeningReport(candidates, decision, defaultPortfolio);
    expect(msg).toContain("❌ Rugpull: YES");
  });

  it("formats wash trading flagged pool", () => {
    const candidates = [makeCandidate("WASH-SOL", { is_wash: true })];
    const decision = { action: "deploy", pair: "WASH-SOL", confidence: "low", summary: "test" };
    const msg = formatScreeningReport(candidates, decision, defaultPortfolio);
    expect(msg).toContain("❌ Wash: YES");
  });
});

// ─── Deploy Notification ─────────────────────────────────────────

describe("formatDeployNotification", () => {
  it("formats basic deploy", () => {
    const msg = formatDeployNotification({ pair: "BONK-SOL", amountSol: 1.5 });
    expect(msg).toContain("<b>🚀 Deployed</b> BONK-SOL");
    expect(msg).toContain("Amount: 1.5 SOL");
  });

  it("includes price range when provided", () => {
    const msg = formatDeployNotification({
      pair: "X-SOL", amountSol: 1,
      priceRange: { min: 0.1, max: 0.5 },
    });
    expect(msg).toContain("Range: 0.100000 → 0.500000");
  });

  it("includes range coverage when provided", () => {
    const msg = formatDeployNotification({
      pair: "X-SOL", amountSol: 1,
      rangeCoverage: { downside_pct: 10, upside_pct: 15, width_pct: 25 },
    });
    expect(msg).toContain("10.00% downside");
    expect(msg).toContain("15.00% upside");
    expect(msg).toContain("25.00% total");
  });

  it("includes bin step and base fee when provided", () => {
    const msg = formatDeployNotification({
      pair: "X-SOL", amountSol: 1,
      binStep: 10, baseFee: 0.25,
    });
    expect(msg).toContain("Bin step: 10");
    expect(msg).toContain("Base fee: 0.25%");
  });

  it("omits optional fields when not provided", () => {
    const msg = formatDeployNotification({ pair: "X-SOL", amountSol: 1 });
    expect(msg).not.toContain("Range:");
    expect(msg).not.toContain("Range cover:");
    expect(msg).not.toContain("Bin step:");
  });
});

// ─── Close Notification (formatter) ──────────────────────────────

describe("formatCloseNotification", () => {
  it("formats positive close", () => {
    const msg = formatCloseNotification({ pair: "BONK-SOL", pnlUsd: 2.5, pnlPct: 6.3 });
    expect(msg).toContain("🟢 <b>Closed</b> BONK-SOL");
    expect(msg).toContain("$2.50");
    expect(msg).toContain("+6.30%");
  });

  it("formats negative close", () => {
    const msg = formatCloseNotification({ pair: "RUG-SOL", pnlUsd: -1.2, pnlPct: -3.1 });
    expect(msg).toContain("🔴 <b>Closed</b> RUG-SOL");
    expect(msg).toContain("-$1.20");
  });

  it("includes reason when provided", () => {
    const msg = formatCloseNotification({
      pair: "X-SOL", pnlUsd: -0.5, pnlPct: -2, reason: "stop loss",
    });
    expect(msg).toContain("Reason: stop loss");
  });

  it("escapes HTML in reason (<= stop loss)", () => {
    const msg = formatCloseNotification({
      pair: "Wish-SOL", pnlUsd: -1.45, pnlPct: -2.33,
      reason: "Trailing TP: Stop loss triggered — PnL -2.32% <= -2%",
    });
    expect(msg).toContain("Reason: Trailing TP: Stop loss triggered — PnL -2.32% &lt;= -2%");
    expect(msg).not.toContain("Reason: Trailing TP: Stop loss triggered — PnL -2.32% <=");
  });

  it("omits reason when not provided", () => {
    const msg = formatCloseNotification({ pair: "X-SOL", pnlUsd: 0, pnlPct: 0 });
    expect(msg).not.toContain("Reason:");
  });

  it("handles null pnlUsd", () => {
    const msg = formatCloseNotification({ pair: "X-SOL", pnlUsd: null, pnlPct: 0 });
    expect(msg).toContain("$0.00");
  });
});

// ─── parseDecision ───────────────────────────────────────────────

describe("parseDecision", () => {
  it("extracts JSON from LLM response", () => {
    const result = parseDecision('Here is my decision: {"action":"deploy","pair":"BONK-SOL"}');
    expect(result.action).toBe("deploy");
    expect(result.pair).toBe("BONK-SOL");
  });

  it("returns skip for unparseable text", () => {
    const result = parseDecision("I have no idea what to do");
    expect(result.action).toBe("skip");
    expect(result.reason).toContain("Could not parse");
  });

  it("returns skip for empty string", () => {
    const result = parseDecision("");
    expect(result.action).toBe("skip");
  });

  it("returns skip for malformed JSON", () => {
    const result = parseDecision("{action: broken}");
    expect(result.action).toBe("skip");
  });

  it("handles JSON with extra text around it", () => {
    const result = parseDecision('Based on analysis, I recommend {"action":"skip","reason":"low volume"} please.');
    expect(result.action).toBe("skip");
    expect(result.reason).toBe("low volume");
  });
});