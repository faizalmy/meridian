/**
 * Tests for executor.js close_position auto-swap retry and scoped fallback sweep.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mutable mock state ──────────────────────────────────
let closePositionResult = { success: true };
let walletBalancesSequence = [];
let walletBalancesCallCount = 0;
let getPoolResult = null;

// ─── Mocks ───────────────────────────────────────────────
vi.mock("../../tools/screening.js", () => ({
  discoverPools: vi.fn(async () => []),
  getPoolDetail: vi.fn(async () => ({})),
  getTopCandidates: vi.fn(async () => []),
}));

vi.mock("../../tools/dlmm.js", () => ({
  getActiveBin: vi.fn(async () => ({})),
  deployPosition: vi.fn(async () => ({})),
  getMyPositions: vi.fn(async () => ({ positions: [], total_positions: 0 })),
  getWalletPositions: vi.fn(async () => []),
  getPositionPnl: vi.fn(async () => ({})),
  claimFees: vi.fn(async () => ({})),
  closePosition: vi.fn(async () => closePositionResult),
  searchPools: vi.fn(async () => []),
  getPool: vi.fn(async () => {
    if (!getPoolResult) throw new Error("no pool");
    return getPoolResult;
  }),
}));

vi.mock("../../tools/wallet.js", () => ({
  getWalletBalances: vi.fn(async () => {
    if (walletBalancesSequence.length > 0) {
      return walletBalancesSequence[walletBalancesCallCount++ % walletBalancesSequence.length];
    }
    return { sol: 2.5, tokens: [] };
  }),
  swapToken: vi.fn(async () => ({ success: true, amount_out: 0.1 })),
}));

vi.mock("../../tools/study.js", () => ({
  studyTopLPers: vi.fn(async () => ({})),
}));

vi.mock("../../tools/token.js", () => ({
  getTokenInfo: vi.fn(async () => ({})),
  getTokenHolders: vi.fn(async () => ({})),
  getTokenNarrative: vi.fn(async () => ({})),
}));

vi.mock("../../lessons.js", () => ({
  addLesson: vi.fn(),
  clearAllLessons: vi.fn(),
  clearPerformance: vi.fn(),
  removeLessonsByKeyword: vi.fn(),
  getPerformanceHistory: vi.fn(() => []),
  pinLesson: vi.fn(),
  unpinLesson: vi.fn(),
  listLessons: vi.fn(() => []),
}));

vi.mock("../../state.js", () => ({
  setPositionInstruction: vi.fn(() => true),
}));

vi.mock("../../pool-memory.js", () => ({
  getPoolMemory: vi.fn(() => ({})),
  addPoolNote: vi.fn(async () => {}),
}));

vi.mock("../../strategy-library.js", () => ({
  addStrategy: vi.fn(),
  listStrategies: vi.fn(() => []),
  getStrategy: vi.fn(() => null),
  setActiveStrategy: vi.fn(),
  removeStrategy: vi.fn(),
}));

vi.mock("../../token-blacklist.js", () => ({
  addToBlacklist: vi.fn(),
  removeFromBlacklist: vi.fn(),
  listBlacklist: vi.fn(() => []),
}));

vi.mock("../../dev-blocklist.js", () => ({
  blockDev: vi.fn(),
  unblockDev: vi.fn(),
  listBlockedDevs: vi.fn(() => []),
}));

vi.mock("../../smart-wallets.js", () => ({
  addSmartWallet: vi.fn(),
  removeSmartWallet: vi.fn(),
  listSmartWallets: vi.fn(() => []),
  checkSmartWalletsOnPool: vi.fn(async () => []),
}));

vi.mock("../../config.js", () => ({
  config: {
    tokens: { SOL: "So11111111111111111111111111111111111111112" },
    screening: {},
    strategy: { minBinsBelow: 5, maxBinsBelow: 15 },
    management: { autoSwapAfterClaim: false },
    risk: { maxPositions: 10, maxDeployAmount: 10, deployAmountSol: 0.1 },
  },
  reloadScreeningThresholds: vi.fn(),
  MIN_SAFE_BINS_BELOW: 5,
}));

vi.mock("../../decision-log.js", () => ({
  getRecentDecisions: vi.fn(() => []),
}));

vi.mock("../../logger.js", () => ({
  log: vi.fn(),
  logAction: vi.fn(),
}));

vi.mock("../../telegram.js", () => ({
  notifyDeploy: vi.fn(),
  notifyClose: vi.fn(),
  notifySwap: vi.fn(),
}));

// ─── Import after mocks ──────────────────────────────────
import { executeTool } from "../../tools/executor.js";
import { getWalletBalances, swapToken } from "../../tools/wallet.js";
import { closePosition as mockClosePosition, getPool } from "../../tools/dlmm.js";

// ─── Helpers ─────────────────────────────────────────────
const SOL_MINT = "So11111111111111111111111111111111111111112";

function resetMocks() {
  closePositionResult = { success: true };
  walletBalancesSequence = [];
  walletBalancesCallCount = 0;
  getPoolResult = null;
  vi.clearAllMocks();
}

// ═══════════════════════════════════════════════════════════
//  TESTS
// ═══════════════════════════════════════════════════════════

describe("executor close_position auto-swap & fallback sweep", () => {
  beforeEach(() => {
    resetMocks();
  });

  // ─── 1: Auto-swap retry ─────────────────────────────
  it("auto-swap retries once after 3s when first balance check is empty", async () => {
    closePositionResult = {
      success: true,
      base_mint: "tokenA",
      pool: "pool_1",
      pool_name: "TOKEN-SOL",
    };

    // First call: empty. Second call: token present.
    walletBalancesSequence = [
      { sol: 2.5, tokens: [] },
      { sol: 2.5, tokens: [{ mint: "tokenA", symbol: "TOKEN", balance: 1000, usd: 5.0 }] },
    ];

    const result = await executeTool("close_position", {
      position_address: "pos_123",
    });

    expect(result.success).toBe(true);
    expect(result.auto_swapped).toBe(true);

    // getWalletBalances should have been called twice (initial + retry)
    expect(getWalletBalances).toHaveBeenCalledTimes(2);

    // swapToken should be called with the correct mint
    expect(swapToken).toHaveBeenCalledTimes(1);
    expect(swapToken).toHaveBeenCalledWith({
      input_mint: "tokenA",
      output_mint: "SOL",
      amount: 1000,
    });
  });

  // ─── 2: Fallback sweep scoped to closed pool ─────────
  it("fallback sweep only swaps the closed pool's token, not other wallet tokens", async () => {
    // close_position returns null base_mint → triggers fallback sweep
    closePositionResult = {
      success: true,
      base_mint: null,
      pool: "pool_closed",
      pool_name: "CLOSED-SOL",
    };

    // Mock getPool to return pool with tokenXMint = "closedToken", tokenYMint = SOL
    getPoolResult = {
      lbPair: {
        tokenXMint: { toString: () => "closedToken" },
        tokenYMint: { toString: () => SOL_MINT },
      },
    };

    // Wallet has tokens from multiple pools
    walletBalancesSequence = [
      {
        sol: 2.5,
        tokens: [
          { mint: "closedToken", symbol: "CLOSED", balance: 500, usd: 3.0 },
          { mint: "otherToken", symbol: "OTHER", balance: 200, usd: 10.0 },
          { mint: "thirdToken", symbol: "THIRD", balance: 100, usd: 1.0 },
        ],
      },
    ];

    const result = await executeTool("close_position", {
      position_address: "pos_456",
    });

    expect(result.success).toBe(true);

    // Only the closed pool's token should be swapped
    expect(swapToken).toHaveBeenCalledTimes(1);
    expect(swapToken).toHaveBeenCalledWith({
      input_mint: "closedToken",
      output_mint: "SOL",
      amount: 500,
    });

    // Verify other tokens were NOT swapped
    const swapCalls = swapToken.mock.calls;
    expect(swapCalls.every(c => c[0].input_mint === "closedToken")).toBe(true);
  });

  // ─── 3: Fallback sweep doesn't swap position tokens ──
  it("fallback sweep swaps only relevant token when multiple pools have tokens", async () => {
    closePositionResult = {
      success: true,
      base_mint: null,
      pool: "pool_xyz",
      pool_name: "BONK-SOL",
    };

    // Pool has tokenXMint = "bonkMint" (the base token), tokenYMint = SOL
    getPoolResult = {
      lbPair: {
        tokenXMint: { toString: () => "bonkMint" },
        tokenYMint: { toString: () => SOL_MINT },
      },
    };

    // Wallet has tokens from the closed pool AND from an open position
    walletBalancesSequence = [
      {
        sol: 1.0,
        tokens: [
          { mint: "bonkMint", symbol: "BONK", balance: 300, usd: 2.5 },
          { mint: "pepeMint", symbol: "PEPE", balance: 500, usd: 15.0 }, // belongs to another open position
          { mint: "dogeMint", symbol: "DOGE", balance: 1000, usd: 20.0 }, // belongs to another open position
        ],
      },
    ];

    const result = await executeTool("close_position", {
      position_address: "pos_xyz",
    });

    expect(result.success).toBe(true);

    // Only bonkMint should be swapped — not pepeMint or dogeMint
    expect(swapToken).toHaveBeenCalledTimes(1);
    expect(swapToken).toHaveBeenCalledWith({
      input_mint: "bonkMint",
      output_mint: "SOL",
      amount: 300,
    });

    // Verify pepeMint and dogeMint were never passed to swapToken
    const swapMints = swapToken.mock.calls.map(c => c[0].input_mint);
    expect(swapMints).not.toContain("pepeMint");
    expect(swapMints).not.toContain("dogeMint");
  });

  // ─── 4: Auto-swap retry gives up after 2nd failure ───
  it("auto-swap gives up when balance is still empty after retry", async () => {
    closePositionResult = {
      success: true,
      base_mint: "tokenA",
      pool: "pool_1",
      pool_name: "TOKEN-SOL",
    };

    // Both calls return empty tokens
    walletBalancesSequence = [
      { sol: 2.5, tokens: [] },
      { sol: 2.5, tokens: [] },
    ];

    const result = await executeTool("close_position", {
      position_address: "pos_789",
    });

    expect(result.success).toBe(true);
    expect(result.auto_swapped).toBeFalsy();

    // getWalletBalances called twice (initial + retry)
    expect(getWalletBalances).toHaveBeenCalledTimes(2);

    // swapToken should NOT have been called
    expect(swapToken).not.toHaveBeenCalled();
  });

  // ─── 5: Fallback sweep doesn't fire when pool missing ─
  it("fallback sweep skips when result.pool is missing", async () => {
    closePositionResult = {
      success: true,
      base_mint: null,
      pool: null,
    };

    const result = await executeTool("close_position", {
      position_address: "pos_no_pool",
    });

    expect(result.success).toBe(true);

    // No wallet scan or swap should happen
    expect(getWalletBalances).not.toHaveBeenCalled();
    expect(swapToken).not.toHaveBeenCalled();
  });

  // ─── 6: Fallback sweep handles getPool failure gracefully ─
  it("fallback sweep handles getPool failure gracefully", async () => {
    closePositionResult = {
      success: true,
      base_mint: null,
      pool: "pool_fail",
    };

    // getPool will throw (getPoolResult is null → default throws)
    getPoolResult = null;

    const result = await executeTool("close_position", {
      position_address: "pos_fail",
    });

    expect(result.success).toBe(true);

    // Should not crash, and no swap should happen
    expect(swapToken).not.toHaveBeenCalled();
  });

  // ─── 7: Fallback sweep handles token too small ────────
  it("fallback sweep skips token with usd below threshold", async () => {
    closePositionResult = {
      success: true,
      base_mint: null,
      pool: "pool_small",
    };

    getPoolResult = {
      lbPair: {
        tokenXMint: { toString: () => "smallToken" },
        tokenYMint: { toString: () => SOL_MINT },
      },
    };

    walletBalancesSequence = [
      {
        sol: 2.5,
        tokens: [
          { mint: "smallToken", symbol: "SMALL", balance: 10, usd: 0.05 }, // below 0.10 threshold
        ],
      },
    ];

    const result = await executeTool("close_position", {
      position_address: "pos_small",
    });

    expect(result.success).toBe(true);

    // Token below threshold should not be swapped
    expect(swapToken).not.toHaveBeenCalled();
  });

  // ─── 8: Auto-swap skip_swap flag prevents swap ───────
  it("auto-swap is skipped when skip_swap is set", async () => {
    closePositionResult = {
      success: true,
      base_mint: "tokenA",
      pool: "pool_1",
    };

    const result = await executeTool("close_position", {
      position_address: "pos_skip",
      skip_swap: true,
    });

    expect(result.success).toBe(true);
    expect(result.auto_swapped).toBeFalsy();

    // No wallet scan or swap should happen
    expect(getWalletBalances).not.toHaveBeenCalled();
    expect(swapToken).not.toHaveBeenCalled();
  });
});
