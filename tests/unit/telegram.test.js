import { describe, it, expect, vi, beforeEach } from "vitest";
import { log } from "../../logger.js";

vi.mock("../../logger.js", () => ({
  log: vi.fn(),
}));

// ─── fetch mock ─────────────────────────────────────────────────────────────
let fetchCalls = [];
const mockFetch = vi.fn((url, opts) => {
  fetchCalls.push({ url, opts });
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ ok: true }),
  });
});
vi.stubGlobal("fetch", mockFetch);

// ─── env setup ──────────────────────────────────────────────────────────────
const ORIG_ENV = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  fetchCalls = [];
  process.env.TELEGRAM_BOT_TOKEN = "test:bot123";
  process.env.TELEGRAM_CHAT_ID = "98765";
  process.env.TELEGRAM_ALLOWED_USER_IDS = "111,222";
  vi.resetModules();
});

afterEach(() => {
  Object.assign(process.env, ORIG_ENV);
});

// ─── helpers ────────────────────────────────────────────────────────────────
function extractSentMessage() {
  if (fetchCalls.length === 0) return null;
  const { opts } = fetchCalls[fetchCalls.length - 1];
  const body = JSON.parse(opts.body);
  return body.text;
}

describe("notifyClose", () => {
  it("includes reason below PnL when provided", async () => {
    const { notifyClose } = await import("../../telegram.js");
    await notifyClose({ pair: "SOL-USDC", pnlUsd: 1.23, pnlPct: 3.45, reason: "take profit: good return" });

    const msg = extractSentMessage();
    expect(msg).toContain("🔒 <b>Closed</b> SOL-USDC");
    expect(msg).toContain("PnL: +$1.23 (+3.45%)");
    expect(msg).toContain("Reason: take profit: good return");
    // reason appears after PnL
    const pnlIdx = msg.indexOf("PnL:");
    const reasonIdx = msg.indexOf("Reason:");
    expect(reasonIdx).toBeGreaterThan(pnlIdx);
  });

  it("omits reason line when reason is not provided (backward compat)", async () => {
    const { notifyClose } = await import("../../telegram.js");
    await notifyClose({ pair: "SOL-USDC", pnlUsd: 1.23, pnlPct: 3.45 });

    const msg = extractSentMessage();
    expect(msg).toContain("🔒 <b>Closed</b> SOL-USDC");
    expect(msg).toContain("PnL: +$1.23 (+3.45%)");
    expect(msg).not.toContain("Reason:");
  });

  it("omits reason line when reason is empty string", async () => {
    const { notifyClose } = await import("../../telegram.js");
    await notifyClose({ pair: "SOL-USDC", pnlUsd: 0.5, pnlPct: 1.2, reason: "" });

    const msg = extractSentMessage();
    expect(msg).not.toContain("Reason:");
  });

  it("shows + sign for positive PnL", async () => {
    const { notifyClose } = await import("../../telegram.js");
    await notifyClose({ pair: "BONK-SOL", pnlUsd: 5.0, pnlPct: 12.5, reason: "take profit" });

    const msg = extractSentMessage();
    expect(msg).toContain("+$5.00 (+12.50%)");
  });

  it("shows - sign for negative PnL", async () => {
    const { notifyClose } = await import("../../telegram.js");
    await notifyClose({ pair: "RKC-SOL", pnlUsd: -3.78, pnlPct: -9.71, reason: "stop loss: PnL -3.22% <= -3%" });

    const msg = extractSentMessage();
    // sign is empty for negatives; toFixed produces "-3.78" → "$-3.78 (-9.71%)"
    expect(msg).toContain("$-3.78 (-9.71%)");
  });

  it("handles zero PnL", async () => {
    const { notifyClose } = await import("../../telegram.js");
    await notifyClose({ pair: "TEST-SOL", pnlUsd: 0, pnlPct: 0, reason: "breakeven" });

    const msg = extractSentMessage();
    expect(msg).toContain("+$0.00 (+0.00%)");
  });

  it("handles null/undefined PnL gracefully", async () => {
    const { notifyClose } = await import("../../telegram.js");
    await notifyClose({ pair: "TEST-SOL", pnlUsd: null, pnlPct: undefined, reason: "test" });

    const msg = extractSentMessage();
    expect(msg).toContain("+$0.00 (+0.00%)");
  });
});

describe("notifyClose reason — real-world close_reason values from lessons.json", () => {
  it("displays stop loss reason from dlmm.js format", async () => {
    const { notifyClose } = await import("../../telegram.js");
    await notifyClose({ pair: "RKC-SOL", pnlUsd: -3.78, pnlPct: -9.71, reason: "stop loss: PnL -3.22% <= -3%" });

    const msg = extractSentMessage();
    expect(msg).toContain("Reason: stop loss: PnL -3.22% <= -3%");
  });

  it("displays user-requested close reason", async () => {
    const { notifyClose } = await import("../../telegram.js");
    await notifyClose({ pair: "ASTEROID-SOL", pnlUsd: 0.57, pnlPct: 1.46, reason: "User requested to close all positions and stop the bot" });

    const msg = extractSentMessage();
    expect(msg).toContain("Reason: User requested to close all positions and stop the bot");
  });

  it("displays low yield reason", async () => {
    const { notifyClose } = await import("../../telegram.js");
    await notifyClose({ pair: "SOL-USDC", pnlUsd: 0.12, pnlPct: 0.3, reason: "low yield" });

    const msg = extractSentMessage();
    expect(msg).toContain("Reason: low yield");
  });

  it("displays out-of-range close reason", async () => {
    const { notifyClose } = await import("../../telegram.js");
    await notifyClose({ pair: "SOL-USDC", pnlUsd: 0.33, pnlPct: 0.86, reason: "Out of range" });

    const msg = extractSentMessage();
    expect(msg).toContain("Reason: Out of range");
  });

  it("displays agent decision default reason", async () => {
    const { notifyClose } = await import("../../telegram.js");
    await notifyClose({ pair: "JUP-SOL", pnlUsd: -1.2, pnlPct: -3.1, reason: "agent decision" });

    const msg = extractSentMessage();
    expect(msg).toContain("Reason: agent decision");
  });
});

// ─── sendMessage routing ──────────────────────────────────────────────────────
describe("sendMessage routing", () => {
  it("sends with parse_mode HTML", async () => {
    const { notifyClose } = await import("../../telegram.js");
    await notifyClose({ pair: "TEST-SOL", pnlUsd: 1, pnlPct: 2, reason: "x" });

    const lastCall = fetchCalls[fetchCalls.length - 1];
    const body = JSON.parse(lastCall.opts.body);
    expect(body.parse_mode).toBe("HTML");
  });

  it("calls the sendMessage Telegram endpoint", async () => {
    const { notifyClose } = await import("../../telegram.js");
    await notifyClose({ pair: "TEST-SOL", pnlUsd: 1, pnlPct: 2 });

    const lastCall = fetchCalls[fetchCalls.length - 1];
    expect(lastCall.url).toContain("sendMessage");
  });
});

// ─── notifyDeploy ─────────────────────────────────────────────────────────────
describe("notifyDeploy", () => {
  it("includes pair and amount", async () => {
    const { notifyDeploy } = await import("../../telegram.js");
    await notifyDeploy({
      pair: "SOL-USDC",
      amountSol: 2.5,
      position: "unused",
      tx: "unused",
    });

    const msg = extractSentMessage();
    expect(msg).toContain("✅ <b>Deployed</b> SOL-USDC");
    expect(msg).toContain("Amount: 2.5 SOL");
  });

  it("includes price range when provided", async () => {
    const { notifyDeploy } = await import("../../telegram.js");
    await notifyDeploy({
      pair: "BONK-SOL",
      amountSol: 1,
      position: "pos123",
      tx: "tx123",
      priceRange: { min: 0.0000123, max: 0.0000456 },
    });

    const msg = extractSentMessage();
    // small values should use exponential notation
    expect(msg).toContain("Price range:");
    expect(msg).toContain("1.230e-5");
    expect(msg).toContain("4.560e-5");
  });

  it("uses toFixed for normal price ranges", async () => {
    const { notifyDeploy } = await import("../../telegram.js");
    await notifyDeploy({
      pair: "SOL-USDC",
      amountSol: 1,
      position: "pos",
      tx: "tx",
      priceRange: { min: 0.123456, max: 0.654321 },
    });

    const msg = extractSentMessage();
    expect(msg).toContain("0.123456");
    expect(msg).toContain("0.654321");
  });

  it("includes range coverage when provided", async () => {
    const { notifyDeploy } = await import("../../telegram.js");
    await notifyDeploy({
      pair: "SOL-USDC",
      amountSol: 1,
      position: "pos",
      tx: "tx",
      rangeCoverage: { downside_pct: 12.5, upside_pct: 8.3, width_pct: 20.8 },
    });

    const msg = extractSentMessage();
    expect(msg).toContain("Range cover:");
    expect(msg).toContain("12.50% downside");
    expect(msg).toContain("8.30% upside");
    expect(msg).toContain("20.80% total");
  });

  it("includes bin step and base fee when provided", async () => {
    const { notifyDeploy } = await import("../../telegram.js");
    await notifyDeploy({
      pair: "SOL-USDC",
      amountSol: 1,
      position: "pos",
      tx: "tx",
      binStep: 10,
      baseFee: 0.25,
    });

    const msg = extractSentMessage();
    expect(msg).toContain("Bin step: 10");
    expect(msg).toContain("Base fee: 0.25%");
  });

  it("omits optional sections when not provided", async () => {
    const { notifyDeploy } = await import("../../telegram.js");
    await notifyDeploy({
      pair: "SOL-USDC",
      amountSol: 1,
      position: "pos",
      tx: "tx",
    });

    const msg = extractSentMessage();
    expect(msg).not.toContain("Price range:");
    expect(msg).not.toContain("Range cover:");
    expect(msg).not.toContain("Bin step:");
  });
});

// ─── notifySwap ───────────────────────────────────────────────────────────────
describe("notifySwap", () => {
  it("shows input/output symbols and amounts with tx", async () => {
    const { notifySwap } = await import("../../telegram.js");
    await notifySwap({
      inputSymbol: "SOL",
      outputSymbol: "USDC",
      amountIn: 1.5,
      amountOut: 225.75,
      tx: "SwapHashAbCdEf123456",
    });

    const msg = extractSentMessage();
    expect(msg).toContain("🔄 <b>Swapped</b> SOL → USDC");
    expect(msg).toContain("In: 1.5 | Out: 225.75");
    expect(msg).toContain("Tx: <code>SwapHashAbCdEf12...</code>");
  });

  it("handles null/undefined amounts gracefully", async () => {
    const { notifySwap } = await import("../../telegram.js");
    await notifySwap({
      inputSymbol: "BONK",
      outputSymbol: "SOL",
      amountIn: null,
      amountOut: undefined,
      tx: "tx123",
    });

    const msg = extractSentMessage();
    expect(msg).toContain("In: ? | Out: ?");
  });

  it("truncates long tx hashes to 16 chars", async () => {
    const { notifySwap } = await import("../../telegram.js");
    await notifySwap({
      inputSymbol: "SOL",
      outputSymbol: "USDC",
      amountIn: 1,
      amountOut: 100,
      tx: "AAAAAAAAAAAAAAAAAAAAAAAA",
    });

    const msg = extractSentMessage();
    expect(msg).toContain("Tx: <code>AAAAAAAAAAAAAAAA...</code>");
  });
});

// ─── notifyOutOfRange ─────────────────────────────────────────────────────────
describe("notifyOutOfRange", () => {
  it("includes pair and minutes OOR", async () => {
    const { notifyOutOfRange } = await import("../../telegram.js");
    await notifyOutOfRange({ pair: "SOL-USDC", minutesOOR: 45 });

    const msg = extractSentMessage();
    expect(msg).toContain("⚠️ <b>Out of Range</b> SOL-USDC");
    expect(msg).toContain("Been OOR for 45 minutes");
  });

  it("handles zero minutes OOR", async () => {
    const { notifyOutOfRange } = await import("../../telegram.js");
    await notifyOutOfRange({ pair: "BONK-SOL", minutesOOR: 0 });

    const msg = extractSentMessage();
    expect(msg).toContain("Been OOR for 0 minutes");
  });
});
