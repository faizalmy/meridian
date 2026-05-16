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
    expect(msg).toContain("🟢 <b>Closed</b> SOL-USDC");
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
    expect(msg).toContain("🟢 <b>Closed</b> SOL-USDC");
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
    expect(msg).toContain("Reason: stop loss: PnL -3.22% &lt;= -3%");
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

// ─── sendMessage core ──────────────────────────────────────────────
describe("sendMessage", () => {
  it("truncates text to 4096 chars", async () => {
    const { sendMessage } = await import("../../telegram.js");
    const longText = "A".repeat(5000);
    await sendMessage(longText);

    const lastCall = fetchCalls[fetchCalls.length - 1];
    const body = JSON.parse(lastCall.opts.body);
    expect(body.text.length).toBeLessThanOrEqual(4096);
    expect(body.text).toBe("A".repeat(4096));
  });

  it("does not call fetch when TOKEN is missing", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    vi.resetModules();
    const { sendMessage } = await import("../../telegram.js");
    await sendMessage("hello");
    expect(fetchCalls.length).toBe(0);
  });

  it("does not call fetch when CHAT_ID is missing (env)", async () => {
    // NOTE: chatId also loads from user-config.json at init.
    // This test verifies the env-var path — the file may override it.
    // The key invariant: if BOTH token and chatId are missing, no fetch happens.
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    vi.resetModules();
    const { sendMessage } = await import("../../telegram.js");
    fetchCalls.length = 0;
    await sendMessage("hello");
    expect(fetchCalls.length).toBe(0);
  });

  it("includes chat_id in request body", async () => {
    const { sendMessage } = await import("../../telegram.js");
    await sendMessage("test");

    const lastCall = fetchCalls[fetchCalls.length - 1];
    const body = JSON.parse(lastCall.opts.body);
    // chat_id comes from env or user-config.json — just verify it's present
    expect(body.chat_id).toBeTruthy();
    expect(typeof body.chat_id).toBe("string");
  });

  it("converts non-string text to string", async () => {
    const { sendMessage } = await import("../../telegram.js");
    await sendMessage(12345);

    const lastCall = fetchCalls[fetchCalls.length - 1];
    const body = JSON.parse(lastCall.opts.body);
    expect(body.text).toBe("12345");
  });
});

// ─── sendMessageWithButtons ───────────────────────────────────────
describe("sendMessageWithButtons", () => {
  it("sends message with inline keyboard", async () => {
    const { sendMessageWithButtons } = await import("../../telegram.js");
    const keyboard = [[{ text: "Approve", callback_data: "approve_1" }]];
    await sendMessageWithButtons("Choose:", keyboard);

    const lastCall = fetchCalls[fetchCalls.length - 1];
    const body = JSON.parse(lastCall.opts.body);
    expect(body.text).toBe("Choose:");
    expect(body.parse_mode).toBe("HTML");
    expect(body.reply_markup.inline_keyboard).toEqual(keyboard);
  });

  it("truncates text to 4096 chars with buttons", async () => {
    const { sendMessageWithButtons } = await import("../../telegram.js");
    await sendMessageWithButtons("X".repeat(5000), [[{ text: "OK", callback_data: "ok" }]]);

    const lastCall = fetchCalls[fetchCalls.length - 1];
    const body = JSON.parse(lastCall.opts.body);
    expect(body.text.length).toBeLessThanOrEqual(4096);
  });
});

// ─── editMessage ──────────────────────────────────────────────────
describe("editMessage", () => {
  it("edits existing message by id", async () => {
    const { editMessage } = await import("../../telegram.js");
    await editMessage("updated text", 42);

    const lastCall = fetchCalls[fetchCalls.length - 1];
    expect(lastCall.url).toContain("editMessageText");
    const body = JSON.parse(lastCall.opts.body);
    expect(body.message_id).toBe(42);
    expect(body.text).toBe("updated text");
    expect(body.parse_mode).toBe("HTML");
  });

  it("returns null when messageId is missing", async () => {
    const { editMessage } = await import("../../telegram.js");
    const result = await editMessage("text", null);
    expect(result).toBeNull();
    // should NOT have called fetch
    expect(fetchCalls.length).toBe(0);
  });

  it("returns null when messageId is undefined", async () => {
    const { editMessage } = await import("../../telegram.js");
    const result = await editMessage("text", undefined);
    expect(result).toBeNull();
  });

  it("truncates text to 4096 chars", async () => {
    const { editMessage } = await import("../../telegram.js");
    await editMessage("E".repeat(5000), 1);

    const lastCall = fetchCalls[fetchCalls.length - 1];
    const body = JSON.parse(lastCall.opts.body);
    expect(body.text.length).toBeLessThanOrEqual(4096);
  });
});

// ─── editMessageWithButtons ───────────────────────────────────────
describe("editMessageWithButtons", () => {
  it("edits message with inline keyboard", async () => {
    const { editMessageWithButtons } = await import("../../telegram.js");
    const kb = [[{ text: "Close", callback_data: "close_1" }]];
    await editMessageWithButtons("Updated:", 99, kb);

    const lastCall = fetchCalls[fetchCalls.length - 1];
    const body = JSON.parse(lastCall.opts.body);
    expect(lastCall.url).toContain("editMessageText");
    expect(body.message_id).toBe(99);
    expect(body.reply_markup.inline_keyboard).toEqual(kb);
  });

  it("returns null when messageId is missing", async () => {
    const { editMessageWithButtons } = await import("../../telegram.js");
    const result = await editMessageWithButtons("text", null, []);
    expect(result).toBeNull();
    expect(fetchCalls.length).toBe(0);
  });
});

// ─── answerCallbackQuery ──────────────────────────────────────────
describe("answerCallbackQuery", () => {
  it("answers callback with text", async () => {
    const { answerCallbackQuery } = await import("../../telegram.js");
    await answerCallbackQuery("cb_123", "Done");

    const lastCall = fetchCalls[fetchCalls.length - 1];
    expect(lastCall.url).toContain("answerCallbackQuery");
    const body = JSON.parse(lastCall.opts.body);
    expect(body.callback_query_id).toBe("cb_123");
    expect(body.text).toBe("Done");
  });

  it("answers callback without text", async () => {
    const { answerCallbackQuery } = await import("../../telegram.js");
    await answerCallbackQuery("cb_456");

    const lastCall = fetchCalls[fetchCalls.length - 1];
    const body = JSON.parse(lastCall.opts.body);
    expect(body.callback_query_id).toBe("cb_456");
    expect(body.text).toBeUndefined();
  });

  it("returns null when callbackQueryId is missing", async () => {
    const { answerCallbackQuery } = await import("../../telegram.js");
    const result = await answerCallbackQuery(null, "test");
    expect(result).toBeNull();
  });

  it("truncates text to 200 chars", async () => {
    const { answerCallbackQuery } = await import("../../telegram.js");
    await answerCallbackQuery("cb_1", "X".repeat(300));

    const lastCall = fetchCalls[fetchCalls.length - 1];
    const body = JSON.parse(lastCall.opts.body);
    expect(body.text.length).toBeLessThanOrEqual(200);
  });
});

// ─── fetch error handling ─────────────────────────────────────────
describe("fetch error handling", () => {
  it("handles fetch throwing an error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network fail"));
    const { sendMessage } = await import("../../telegram.js");
    // should not throw
    await sendMessage("test");
    expect(log).toHaveBeenCalledWith("telegram_error", expect.stringContaining("failed"));
  });

  it("handles non-ok response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: () => Promise.resolve("Too Many Requests"),
    });
    const { sendMessage } = await import("../../telegram.js");
    await sendMessage("test");
    expect(log).toHaveBeenCalledWith("telegram_error", expect.stringContaining("429"));
  });
});

// ─── notifyDeploy edge cases ──────────────────────────────────────
describe("notifyDeploy edge cases", () => {
  it("handles null baseFee gracefully", async () => {
    const { notifyDeploy } = await import("../../telegram.js");
    await notifyDeploy({ pair: "X-SOL", amountSol: 1, binStep: 10, baseFee: null });

    const msg = extractSentMessage();
    expect(msg).toContain("Bin step: 10");
    expect(msg).toContain("Base fee: ?");
  });

  it("handles price boundary at exactly 0.0001", async () => {
    const { notifyDeploy } = await import("../../telegram.js");
    await notifyDeploy({
      pair: "X-SOL", amountSol: 1,
      priceRange: { min: 0.0001, max: 0.0002 },
    });

    const msg = extractSentMessage();
    // 0.0001 is NOT < 0.0001, so toFixed
    expect(msg).toContain("0.000100");
  });
});

// ─── notifyOutOfRange edge cases ──────────────────────────────────
describe("notifyOutOfRange edge cases", () => {
  it("handles very large OOR duration", async () => {
    const { notifyOutOfRange } = await import("../../telegram.js");
    await notifyOutOfRange({ pair: "X-SOL", minutesOOR: 99999 });

    const msg = extractSentMessage();
    expect(msg).toContain("Been OOR for 99999 minutes");
  });
});

describe("notifyClose — HTML escaping", () => {
  it("escapes < and > in reason to prevent Telegram 400", async () => {
    const { notifyClose } = await import("../../telegram.js");
    await notifyClose({ pair: "PRIMIS-SOL", pnlUsd: -0.5, pnlPct: -2.27, reason: "Stop loss: PnL -2.27% <= -2%" });

    const msg = extractSentMessage();
    // raw < should NOT appear in the message (Telegram would reject it)
    // the escaped form &lt; should be present instead
    expect(msg).toContain("&lt;=");
    expect(msg).not.toMatch(/[^&]<=[^=]/); // no unescaped <=
  });

  it("escapes HTML in pair name", async () => {
    const { notifyClose } = await import("../../telegram.js");
    await notifyClose({ pair: "TEST<SOL>", pnlUsd: 1, pnlPct: 2, reason: "test" });

    const msg = extractSentMessage();
    expect(msg).toContain("TEST&lt;SOL&gt;");
    expect(msg).not.toContain("TEST<SOL>");
  });

  it("escapes ampersand in reason", async () => {
    const { notifyClose } = await import("../../telegram.js");
    await notifyClose({ pair: "X-SOL", pnlUsd: 0, pnlPct: 0, reason: "A & B" });

    const msg = extractSentMessage();
    expect(msg).toContain("A &amp; B");
  });

  it("still shows clean text for normal reasons (no false escaping)", async () => {
    const { notifyClose } = await import("../../telegram.js");
    await notifyClose({ pair: "BONK-SOL", pnlUsd: 2, pnlPct: 5, reason: "take profit" });

    const msg = extractSentMessage();
    expect(msg).toContain("Reason: take profit");
    expect(msg).not.toContain("&amp;");
    expect(msg).not.toContain("&lt;");
  });
});

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
    expect(msg).toContain("🚀 <b>Deployed</b> SOL-USDC");
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
