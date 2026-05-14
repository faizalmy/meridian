/**
 * Behavioral tests for deploy_position ONCE_PER_SESSION tracking.
 * Tests the actual agentLoop function with mocked OpenAI + executeTool.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Track executeTool calls ────────────────────────────
let executeToolCalls = [];
let executeToolHandler = null;

vi.mock("../../tools/executor.js", () => ({
  executeTool: vi.fn(async (name, args) => {
    executeToolCalls.push({ name, args });
    return executeToolHandler ? executeToolHandler(name, args) : { success: true };
  }),
}));

// ─── Mock OpenAI client ─────────────────────────────────
let openaiResponseQueue = [];

vi.mock("openai", () => {
  const MockOpenAI = function() {
    this.chat = {
      completions: {
        create: vi.fn(async () => {
          if (openaiResponseQueue.length === 0) {
            return { choices: [{ message: { role: "assistant", content: "done" } }] };
          }
          return openaiResponseQueue.shift();
        }),
      },
    };
  };
  return { default: MockOpenAI };
});

// ─── Mock all other dependencies ────────────────────────
vi.mock("../../logger.js", () => ({
  log: vi.fn(),
  logAction: vi.fn(),
}));

vi.mock("../../config.js", () => ({
  config: {
    llm: { temperature: 0.3, maxTokens: 4096, maxSteps: 20 },
    screening: {},
    darwin: { enabled: false },
    strategy: { minBinsBelow: 5, maxBinsBelow: 15 },
  },
}));

vi.mock("../../state.js", () => ({
  getStateSummary: vi.fn(() => "State: 0 positions"),
}));

vi.mock("../../lessons.js", () => ({
  getLessonsForPrompt: vi.fn(() => []),
  getPerformanceSummary: vi.fn(() => ""),
}));

vi.mock("../../decision-log.js", () => ({
  getDecisionSummary: vi.fn(() => ""),
}));

vi.mock("../../pool-memory.js", () => ({
  getPoolMemory: vi.fn(() => ({})),
}));

vi.mock("../../telegram.js", () => ({
  notifyDeploy: vi.fn(),
  notifyClose: vi.fn(),
  notifySwap: vi.fn(),
}));

vi.mock("../../tools/wallet.js", () => ({
  getWalletBalances: vi.fn(async () => ({ sol: 2.5, tokens: [] })),
}));

vi.mock("../../tools/dlmm.js", () => ({
  getMyPositions: vi.fn(async () => []),
}));

vi.mock("../../signal-weights.js", () => ({
  getWeightsSummary: vi.fn(() => ""),
}));

vi.mock("../../prompt.js", () => ({
  buildSystemPrompt: vi.fn(() => "You are a trading agent."),
}));

// ─── Helpers ────────────────────────────────────────────

function toolCall(name, args = {}) {
  return {
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
    }],
  };
}

function finalAnswer(text = "done") {
  return {
    choices: [{
      message: { role: "assistant", content: text },
    }],
  };
}

// ═══════════════════════════════════════════════════════════
//  BEHAVIORAL TESTS
// ═══════════════════════════════════════════════════════════

describe("agentLoop deploy tracking — behavioral", () => {
  beforeEach(() => {
    executeToolCalls = [];
    executeToolHandler = null;
    openaiResponseQueue = [];
  });

  // ─── Scenario 1: Blocked deploy allows retry ──────────

  it("blocked deploy → allows retry with different pool", async () => {
    const { agentLoop } = await import("../../agent.js");

    // Step 1: LLM tries Pool A → blocked
    // Step 2: LLM tries Pool B → success
    // Step 3: LLM reports result
    openaiResponseQueue = [
      toolCall("deploy_position", { pool_address: "poolA" }),
      toolCall("deploy_position", { pool_address: "poolB" }),
      finalAnswer("Deployed to Pool B"),
    ];

    executeToolHandler = (name, args) => {
      if (name === "deploy_position" && args.pool_address === "poolA") {
        return { blocked: true, reason: "TVL below $5K minimum" };
      }
      if (name === "deploy_position" && args.pool_address === "poolB") {
        return { success: true, position: "pos_123", pool_name: "TOKEN-SOL" };
      }
      return { success: true };
    };

    const result = await agentLoop("deploy to best pool", 10);

    // executeTool should have been called TWICE for deploy_position
    const deployCalls = executeToolCalls.filter(c => c.name === "deploy_position");
    expect(deployCalls).toHaveLength(2);
    expect(deployCalls[0].args.pool_address).toBe("poolA");
    expect(deployCalls[1].args.pool_address).toBe("poolB");
  });

  // ─── Scenario 2: Successful deploy locks ──────────────

  it("successful deploy → locks (no second deploy allowed)", async () => {
    const { agentLoop } = await import("../../agent.js");

    // Step 1: LLM deploys → success
    // Step 2: LLM tries to deploy again → blocked by ONCE_PER_SESSION
    // Step 3: LLM reports result
    openaiResponseQueue = [
      toolCall("deploy_position", { pool_address: "poolA" }),
      toolCall("deploy_position", { pool_address: "poolB" }),
      finalAnswer("Deployed to Pool A"),
    ];

    executeToolHandler = (name, args) => {
      if (name === "deploy_position") {
        return { success: true, position: "pos_123", pool_name: "TOKEN-SOL" };
      }
      return { success: true };
    };

    const result = await agentLoop("deploy to best pool", 10);

    // executeTool should have been called ONCE — second deploy blocked by agent
    const deployCalls = executeToolCalls.filter(c => c.name === "deploy_position");
    expect(deployCalls).toHaveLength(1);
  });

  // ─── Scenario 3: Max attempts blocks 4th call ─────────

  it("3 blocked deploys → 4th deploy blocked before executeTool", async () => {
    const { agentLoop } = await import("../../agent.js");

    // Step 1-3: LLM tries 3 pools → all blocked
    // Step 4: LLM tries 4th pool → blocked by MAX_DEPLOY_ATTEMPTS guard
    // Step 5: LLM reports result
    openaiResponseQueue = [
      toolCall("deploy_position", { pool_address: "poolA" }),
      toolCall("deploy_position", { pool_address: "poolB" }),
      toolCall("deploy_position", { pool_address: "poolC" }),
      toolCall("deploy_position", { pool_address: "poolD" }),
      finalAnswer("All pools blocked"),
    ];

    executeToolHandler = (name, args) => {
      if (name === "deploy_position") {
        return { blocked: true, reason: "safety check failed" };
      }
      return { success: true };
    };

    const result = await agentLoop("deploy to best pool", 10);

    // executeTool should have been called 3 times (not 4)
    // The 4th call is blocked by the MAX_DEPLOY_ATTEMPTS guard
    const deployCalls = executeToolCalls.filter(c => c.name === "deploy_position");
    expect(deployCalls).toHaveLength(3);
  });

  // ─── Scenario 4: 1 blocked then 1 success → locks ────

  it("1 blocked + 1 success → locks after success", async () => {
    const { agentLoop } = await import("../../agent.js");

    openaiResponseQueue = [
      toolCall("deploy_position", { pool_address: "poolA" }),
      toolCall("deploy_position", { pool_address: "poolB" }),
      finalAnswer("Deployed"),
    ];

    executeToolHandler = (name, args) => {
      if (name === "deploy_position" && args.pool_address === "poolA") {
        return { blocked: true, reason: "fee/TVL too low" };
      }
      if (name === "deploy_position" && args.pool_address === "poolB") {
        return { success: true, position: "pos_456" };
      }
      return { success: true };
    };

    await agentLoop("deploy", 10);

    const deployCalls = executeToolCalls.filter(c => c.name === "deploy_position");
    expect(deployCalls).toHaveLength(2);
    // Second call should be poolB (success), and no third call
  });

  // ─── Scenario 5: close_position success locks ─────────

  it("close_position success → locks close for session", async () => {
    const { agentLoop } = await import("../../agent.js");

    openaiResponseQueue = [
      toolCall("close_position", { position_address: "pos_123" }),
      toolCall("close_position", { position_address: "pos_456" }),
      finalAnswer("Closed"),
    ];

    executeToolHandler = (name) => {
      if (name === "close_position") {
        return { success: true, pnl_usd: -0.5, base_mint: "tokenA" };
      }
      return { success: true };
    };

    await agentLoop("close position", 10);

    const closeCalls = executeToolCalls.filter(c => c.name === "close_position");
    expect(closeCalls).toHaveLength(1);
  });

  // ─── Scenario 6: close_position failure allows retry ──

  it("close_position failure → allows retry", async () => {
    const { agentLoop } = await import("../../agent.js");

    openaiResponseQueue = [
      toolCall("close_position", { position_address: "pos_123" }),
      toolCall("close_position", { position_address: "pos_123" }),
      finalAnswer("Closed"),
    ];

    let closeAttempts = 0;
    executeToolHandler = (name) => {
      if (name === "close_position") {
        closeAttempts++;
        if (closeAttempts === 1) {
          return { success: false, error: "RPC timeout" };
        }
        return { success: true, pnl_usd: -0.5, base_mint: "tokenA" };
      }
      return { success: true };
    };

    await agentLoop("close position", 10);

    const closeCalls = executeToolCalls.filter(c => c.name === "close_position");
    expect(closeCalls).toHaveLength(2);
  });

  // ─── Scenario 7: swap_token success locks ─────────────

  it("swap_token success → locks swap for session", async () => {
    const { agentLoop } = await import("../../agent.js");

    openaiResponseQueue = [
      toolCall("swap_token", { input_mint: "tokenA", output_mint: "SOL", amount: 100 }),
      toolCall("swap_token", { input_mint: "tokenB", output_mint: "SOL", amount: 200 }),
      finalAnswer("Swapped"),
    ];

    executeToolHandler = (name) => {
      if (name === "swap_token") {
        return { success: true, amount_out: 0.5 };
      }
      return { success: true };
    };

    await agentLoop("swap tokens", 10);

    const swapCalls = executeToolCalls.filter(c => c.name === "swap_token");
    expect(swapCalls).toHaveLength(1);
  });

  // ─── Scenario 8: swap_token failure allows retry ──────

  it("swap_token failure → allows retry", async () => {
    const { agentLoop } = await import("../../agent.js");

    openaiResponseQueue = [
      toolCall("swap_token", { input_mint: "tokenA", output_mint: "SOL", amount: 100 }),
      toolCall("swap_token", { input_mint: "tokenA", output_mint: "SOL", amount: 100 }),
      finalAnswer("Swapped"),
    ];

    let swapAttempts = 0;
    executeToolHandler = (name) => {
      if (name === "swap_token") {
        swapAttempts++;
        if (swapAttempts === 1) {
          return { success: false, error: "Slippage exceeded" };
        }
        return { success: true, amount_out: 0.5 };
      }
      return { success: true };
    };

    await agentLoop("swap tokens", 10);

    const swapCalls = executeToolCalls.filter(c => c.name === "swap_token");
    expect(swapCalls).toHaveLength(2);
  });

  // ─── Scenario 9: deploy + close independent ───────────

  it("deploy blocked + close success → independent locks", async () => {
    const { agentLoop } = await import("../../agent.js");

    openaiResponseQueue = [
      toolCall("deploy_position", { pool_address: "poolA" }),
      toolCall("close_position", { position_address: "pos_123" }),
      finalAnswer("Done"),
    ];

    executeToolHandler = (name, args) => {
      if (name === "deploy_position") {
        return { blocked: true, reason: "TVL too low" };
      }
      if (name === "close_position") {
        return { success: true, pnl_usd: 1.0, base_mint: "tokenA" };
      }
      return { success: true };
    };

    await agentLoop("deploy and close", 10);

    const deployCalls = executeToolCalls.filter(c => c.name === "deploy_position");
    const closeCalls = executeToolCalls.filter(c => c.name === "close_position");
    expect(deployCalls).toHaveLength(1);
    expect(closeCalls).toHaveLength(1);
  });

  // ─── Scenario 10: blocked then non-deploy tool ────────

  it("blocked deploy + get_wallet_balance → balance still works", async () => {
    const { agentLoop } = await import("../../agent.js");

    openaiResponseQueue = [
      toolCall("deploy_position", { pool_address: "poolA" }),
      toolCall("get_wallet_balance", {}),
      finalAnswer("Balance checked"),
    ];

    executeToolHandler = (name) => {
      if (name === "deploy_position") {
        return { blocked: true, reason: "safety check" };
      }
      if (name === "get_wallet_balance") {
        return { success: true, sol: 2.5 };
      }
      return { success: true };
    };

    await agentLoop("check balance and deploy", 10);

    const deployCalls = executeToolCalls.filter(c => c.name === "deploy_position");
    const balanceCalls = executeToolCalls.filter(c => c.name === "get_wallet_balance");
    expect(deployCalls).toHaveLength(1);
    expect(balanceCalls).toHaveLength(1);
  });
});
