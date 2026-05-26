import { describe, it, expect } from "vitest";
import {
  computeRankScore,
  rankCandidates,
  pickBestCandidate,
  computeDeployArgs,
} from "../../tools/screening.js";

// ─── Mock candidate matching the real shape ──────────────────────────────────

function makeCandidate(overrides = {}) {
  const pool = {
    pool: "test-pool-address",
    name: "TEST-SOL",
    fee_active_tvl_ratio: 5.0,
    organic_score: 80,
    volume_window: 5000,
    tvl: 50000,
    mcap: 500000,
    volatility: 4.5,
    risk_level: "LOW",
    is_rugpull: false,
    is_wash: false,
    bin_step: 10,
    fee_pct: 1,
    holders: 500,
    base: { mint: "test-mint" },
    ...overrides.pool,
  };

  const sw = {
    in_pool: [{ name: "TestWallet", category: "lp", address: "0xtest" }],
    ...overrides.sw,
  };

  const n = {
    narrative: "meme coin trending on CT",
    ...overrides.n,
  };

  const ti = {
    audit: { bot_holders_pct: 5, top_holders_pct: 30 },
    global_fees_sol: 50,
    launchpad: null,
    stats_1h: { price_change: 2.5, net_buyers: 100 },
    ...overrides.ti,
  };

  const ds = {
    ds_price_change_1h: 2.5,
    ds_buys_1h: 200,
    ds_sells_1h: 100,
    ...overrides.ds,
  };

  const gmgn = {
    smartMoneyBuys: 3,
    smartMoneySells: 1,
    kolBuys: 0,
    clusterSignal: null,
    ...overrides.gmgn,
  };

  // Destructure nested keys from overrides so they don't clobber
  const { pool: _p, sw: _sw, n: _n, ti: _ti, ds: _ds, gmgn: _gmgn, ...rest } = overrides;

  return {
    pool,
    sw,
    n,
    ti,
    ds,
    gmgn,
    mem: null,
    active_bin: 1234,
    ...rest,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
//  1. computeRankScore
// ═════════════════════════════════════════════════════════════════════════════

describe("computeRankScore", () => {
  it("returns a score between 0 and 100", () => {
    const c = makeCandidate();
    const { score } = computeRankScore(c);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it("returns breakdown object with all 7 signal keys", () => {
    const { breakdown } = computeRankScore(makeCandidate());
    expect(Object.keys(breakdown).sort()).toEqual(
      ["fee_tvl", "smart_wallets", "narrative", "organic", "volume", "risk", "momentum"].sort()
    );
  });

  // ── fee_tvl ───────────────────────────────────────────────────────────

  it("fee_tvl: 0% ratio → score 0", () => {
    const c = makeCandidate({ pool: { fee_active_tvl_ratio: 0 } });
    expect(computeRankScore(c).breakdown.fee_tvl).toBe(0);
  });

  it("fee_tvl: 5% ratio → score 50", () => {
    const c = makeCandidate({ pool: { fee_active_tvl_ratio: 5 } });
    expect(computeRankScore(c).breakdown.fee_tvl).toBe(50);
  });

  it("fee_tvl: 10% ratio → score 100", () => {
    const c = makeCandidate({ pool: { fee_active_tvl_ratio: 10 } });
    expect(computeRankScore(c).breakdown.fee_tvl).toBe(100);
  });

  it("fee_tvl: >10% ratio → capped at 100", () => {
    const c = makeCandidate({ pool: { fee_active_tvl_ratio: 15 } });
    expect(computeRankScore(c).breakdown.fee_tvl).toBe(100);
  });

  it("fee_tvl: NaN → score 0", () => {
    const c = makeCandidate({ pool: { fee_active_tvl_ratio: NaN } });
    expect(computeRankScore(c).breakdown.fee_tvl).toBe(0);
  });

  it("fee_tvl: undefined → score 0", () => {
    const c = makeCandidate({ pool: { fee_active_tvl_ratio: undefined } });
    expect(computeRankScore(c).breakdown.fee_tvl).toBe(0);
  });

  it("fee_tvl: missing field entirely → score 0", () => {
    // Build candidate with pool that has no fee_active_tvl_ratio at all
    const c = makeCandidate();
    delete c.pool.fee_active_tvl_ratio;
    expect(computeRankScore(c).breakdown.fee_tvl).toBe(0);
  });

  // ── smart_wallets ─────────────────────────────────────────────────────

  it("smart_wallets: 0 SW → score 0", () => {
    const c = makeCandidate({ sw: { in_pool: [] } });
    expect(computeRankScore(c).breakdown.smart_wallets).toBe(0);
  });

  it("smart_wallets: 1 SW (non-KOL) → score 60", () => {
    const c = makeCandidate({
      sw: { in_pool: [{ name: "W1", category: "lp", address: "0x1" }] },
    });
    expect(computeRankScore(c).breakdown.smart_wallets).toBe(60);
  });

  it("smart_wallets: 2+ SW (non-KOL) → score 80", () => {
    const c = makeCandidate({
      sw: {
        in_pool: [
          { name: "W1", category: "lp", address: "0x1" },
          { name: "W2", category: "lp", address: "0x2" },
        ],
      },
    });
    expect(computeRankScore(c).breakdown.smart_wallets).toBe(80);
  });

  it("smart_wallets: category='kol' → +20 bonus", () => {
    const c = makeCandidate({
      sw: { in_pool: [{ name: "KOL1", category: "kol", address: "0xK" }] },
    });
    // 1 SW = 60, + kol bonus = 80
    expect(computeRankScore(c).breakdown.smart_wallets).toBe(80);
  });

  it("smart_wallets: category='KOL' (uppercase) → +20 bonus", () => {
    const c = makeCandidate({
      sw: { in_pool: [{ name: "KOL2", category: "KOL", address: "0xK" }] },
    });
    expect(computeRankScore(c).breakdown.smart_wallets).toBe(80);
  });

  it("smart_wallets: category='lp' → no bonus", () => {
    const c = makeCandidate({
      sw: { in_pool: [{ name: "LP1", category: "lp", address: "0x1" }] },
    });
    expect(computeRankScore(c).breakdown.smart_wallets).toBe(60);
  });

  it("smart_wallets: empty in_pool → 0", () => {
    const c = makeCandidate({ sw: { in_pool: [] } });
    expect(computeRankScore(c).breakdown.smart_wallets).toBe(0);
  });

  it("smart_wallets: null in_pool → 0", () => {
    const c = makeCandidate({ sw: { in_pool: null } });
    expect(computeRankScore(c).breakdown.smart_wallets).toBe(0);
  });

  it("smart_wallets: missing in_pool → 0", () => {
    const c = makeCandidate();
    delete c.sw.in_pool;
    expect(computeRankScore(c).breakdown.smart_wallets).toBe(0);
  });

  // ── narrative ─────────────────────────────────────────────────────────

  it("narrative: present text → score 70", () => {
    const c = makeCandidate({ n: { narrative: "moon soon" } });
    expect(computeRankScore(c).breakdown.narrative).toBe(70);
  });

  it("narrative: empty string → score 0", () => {
    const c = makeCandidate({ n: { narrative: "" } });
    expect(computeRankScore(c).breakdown.narrative).toBe(0);
  });

  it("narrative: null → score 0", () => {
    const c = makeCandidate({ n: { narrative: null } });
    expect(computeRankScore(c).breakdown.narrative).toBe(0);
  });

  it("narrative: missing field → score 0", () => {
    const c = makeCandidate();
    delete c.n.narrative;
    expect(computeRankScore(c).breakdown.narrative).toBe(0);
  });

  // ── organic ───────────────────────────────────────────────────────────

  it("organic: linear 0-100 maps to 0-100", () => {
    const c50 = makeCandidate({ pool: { organic_score: 50 } });
    expect(computeRankScore(c50).breakdown.organic).toBe(50);

    const c100 = makeCandidate({ pool: { organic_score: 100 } });
    expect(computeRankScore(c100).breakdown.organic).toBe(100);

    const c0 = makeCandidate({ pool: { organic_score: 0 } });
    expect(computeRankScore(c0).breakdown.organic).toBe(0);
  });

  it("organic: negative → clamped to 0", () => {
    const c = makeCandidate({ pool: { organic_score: -30 } });
    expect(computeRankScore(c).breakdown.organic).toBe(0);
  });

  it("organic: >100 → clamped to 100", () => {
    const c = makeCandidate({ pool: { organic_score: 150 } });
    expect(computeRankScore(c).breakdown.organic).toBe(100);
  });

  // ── volume ────────────────────────────────────────────────────────────

  it("volume: 1 → score 0 (log10(1)*20)", () => {
    const c = makeCandidate({ pool: { volume_window: 1 } });
    expect(computeRankScore(c).breakdown.volume).toBe(0);
  });

  it("volume: 10 → score 20", () => {
    const c = makeCandidate({ pool: { volume_window: 10 } });
    expect(computeRankScore(c).breakdown.volume).toBe(20);
  });

  it("volume: 100 → score 40", () => {
    const c = makeCandidate({ pool: { volume_window: 100 } });
    expect(computeRankScore(c).breakdown.volume).toBe(40);
  });

  it("volume: 1000 → score 60", () => {
    const c = makeCandidate({ pool: { volume_window: 1000 } });
    expect(computeRankScore(c).breakdown.volume).toBe(60);
  });

  it("volume: 10000 → score 80", () => {
    const c = makeCandidate({ pool: { volume_window: 10000 } });
    expect(computeRankScore(c).breakdown.volume).toBe(80);
  });

  it("volume: 100000 → score 100", () => {
    const c = makeCandidate({ pool: { volume_window: 100000 } });
    expect(computeRankScore(c).breakdown.volume).toBe(100);
  });

  // ── risk ──────────────────────────────────────────────────────────────

  it("risk: LOW → score 80", () => {
    const c = makeCandidate({ pool: { risk_level: "LOW", is_rugpull: false, is_wash: false } });
    expect(computeRankScore(c).breakdown.risk).toBe(80);
  });

  it("risk: MEDIUM → score 50", () => {
    const c = makeCandidate({ pool: { risk_level: "MEDIUM", is_rugpull: false, is_wash: false } });
    expect(computeRankScore(c).breakdown.risk).toBe(50);
  });

  it("risk: HIGH → score 20", () => {
    const c = makeCandidate({ pool: { risk_level: "HIGH", is_rugpull: false, is_wash: false } });
    expect(computeRankScore(c).breakdown.risk).toBe(20);
  });

  it("risk: missing risk_level → defaults to 50", () => {
    const c = makeCandidate({ pool: { risk_level: "", is_rugpull: false, is_wash: false } });
    expect(computeRankScore(c).breakdown.risk).toBe(50);
  });

  it("risk: rugpull → 0", () => {
    const c = makeCandidate({ pool: { is_rugpull: true } });
    expect(computeRankScore(c).breakdown.risk).toBe(0);
  });

  it("risk: wash trading → 0", () => {
    const c = makeCandidate({ pool: { is_wash: true } });
    expect(computeRankScore(c).breakdown.risk).toBe(0);
  });

  it("risk: rugpull + wash both → 0", () => {
    const c = makeCandidate({ pool: { is_rugpull: true, is_wash: true } });
    expect(computeRankScore(c).breakdown.risk).toBe(0);
  });

  it("risk: rugpull overrides LOW risk_level → 0", () => {
    const c = makeCandidate({
      pool: { risk_level: "LOW", is_rugpull: true, is_wash: false },
    });
    expect(computeRankScore(c).breakdown.risk).toBe(0);
  });

  // ── momentum ──────────────────────────────────────────────────────────

  it("momentum: +5% → 100", () => {
    const c = makeCandidate({ ds: { ds_price_change_1h: 5 } });
    // 50 + Math.min(5*10, 50) = 50 + 50 = 100
    expect(computeRankScore(c).breakdown.momentum).toBe(100);
  });

  it("momentum: -5% → 0", () => {
    const c = makeCandidate({ ds: { ds_price_change_1h: -5 } });
    // Math.max(0, 50 + (-5)*10) = Math.max(0, 0) = 0
    expect(computeRankScore(c).breakdown.momentum).toBe(0);
  });

  it("momentum: 0% → 50", () => {
    const c = makeCandidate({ ds: { ds_price_change_1h: 0 } });
    expect(computeRankScore(c).breakdown.momentum).toBe(50);
  });

  it("momentum: -10% → 0 (clamped)", () => {
    const c = makeCandidate({ ds: { ds_price_change_1h: -10 } });
    // Math.max(0, 50 + (-10)*10) = Math.max(0, -50) = 0
    expect(computeRankScore(c).breakdown.momentum).toBe(0);
  });

  it("momentum: +10% → 100 (clamped)", () => {
    const c = makeCandidate({ ds: { ds_price_change_1h: 10 } });
    // 50 + Math.min(10*10, 50) = 50 + 50 = 100
    expect(computeRankScore(c).breakdown.momentum).toBe(100);
  });

  it("momentum: undefined → falls back to 0 via || 0 → mid (50)", () => {
    // ds_price_change_1h undefined → (undefined || 0) = 0 → Number(0) = 0 → momentum = 50
    const c = makeCandidate({ ds: { ds_price_change_1h: undefined } });
    expect(computeRankScore(c).breakdown.momentum).toBe(50);
  });

  it("momentum: NaN → falls back to 0 via || 0 → mid (50)", () => {
    // NaN || 0 = 0 (NaN is falsy) → momentum = 50
    const c = makeCandidate({ ds: { ds_price_change_1h: NaN } });
    expect(computeRankScore(c).breakdown.momentum).toBe(50);
  });

  // ── weighted sum / determinism / robustness ────────────────────────────

  it("weighted sum matches manual calculation", () => {
    const c = makeCandidate();
    const { score, breakdown } = computeRankScore(c);
    const w = { feeTvl: 0.25, smartWallets: 0.20, narrative: 0.15, organic: 0.10, volume: 0.10, risk: 0.10, momentum: 0.10 };
    const expected =
      breakdown.fee_tvl * w.feeTvl +
      breakdown.smart_wallets * w.smartWallets +
      breakdown.narrative * w.narrative +
      breakdown.organic * w.organic +
      breakdown.volume * w.volume +
      breakdown.risk * w.risk +
      breakdown.momentum * w.momentum;
    expect(score).toBe(Math.round(expected * 100) / 100);
  });

  it("deterministic: same input → same output", () => {
    const c = makeCandidate();
    const s1 = computeRankScore(c);
    const s2 = computeRankScore(c);
    expect(s1.score).toBe(s2.score);
    expect(s1.breakdown).toEqual(s2.breakdown);
  });

  it("missing/swapped fields don't crash", () => {
    // Candidate with almost nothing
    const minimal = { pool: {}, sw: {}, n: {}, ds: {} };
    const { score, breakdown } = computeRankScore(minimal);
    expect(typeof score).toBe("number");
    expect(score).toBeGreaterThanOrEqual(0);
    expect(Object.keys(breakdown).length).toBe(7);
  });

  it("completely empty candidate doesn't crash", () => {
    const { score, breakdown } = computeRankScore({});
    expect(typeof score).toBe("number");
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  2. rankCandidates
// ═════════════════════════════════════════════════════════════════════════════

describe("rankCandidates", () => {
  it("returns array sorted by score descending", () => {
    const low = makeCandidate({ pool: { fee_active_tvl_ratio: 0.5 } });
    const high = makeCandidate({ pool: { fee_active_tvl_ratio: 9.0 } });
    const mid = makeCandidate({ pool: { fee_active_tvl_ratio: 5.0 } });

    const ranked = rankCandidates([low, high, mid]);
    expect(ranked.length).toBe(3);
    expect(ranked[0].rank_score).toBeGreaterThanOrEqual(ranked[1].rank_score);
    expect(ranked[1].rank_score).toBeGreaterThanOrEqual(ranked[2].rank_score);
  });

  it("each entry has rank_score and rank_breakdown", () => {
    const ranked = rankCandidates([makeCandidate()]);
    expect(ranked[0]).toHaveProperty("rank_score");
    expect(ranked[0]).toHaveProperty("rank_breakdown");
    expect(typeof ranked[0].rank_score).toBe("number");
    expect(typeof ranked[0].rank_breakdown).toBe("object");
  });

  it("empty input returns empty array", () => {
    expect(rankCandidates([])).toEqual([]);
  });

  it("null input returns empty array", () => {
    expect(rankCandidates(null)).toEqual([]);
  });

  it("undefined input returns empty array", () => {
    expect(rankCandidates(undefined)).toEqual([]);
  });

  it("single candidate returns array with that candidate", () => {
    const c = makeCandidate();
    const ranked = rankCandidates([c]);
    expect(ranked.length).toBe(1);
    expect(ranked[0].pool.pool).toBe("test-pool-address");
    expect(typeof ranked[0].rank_score).toBe("number");
  });

  it("does not mutate original array", () => {
    const candidates = [
      makeCandidate({ pool: { fee_active_tvl_ratio: 1 } }),
      makeCandidate({ pool: { fee_active_tvl_ratio: 9 } }),
    ];
    const originalOrder = candidates.map((c) => c.pool.fee_active_tvl_ratio);
    rankCandidates(candidates);
    expect(candidates.map((c) => c.pool.fee_active_tvl_ratio)).toEqual(originalOrder);
  });

  it("preserves original candidate properties (pool, sw, n, ds, etc.)", () => {
    const ranked = rankCandidates([makeCandidate()]);
    const r = ranked[0];
    expect(r.pool).toBeDefined();
    expect(r.sw).toBeDefined();
    expect(r.n).toBeDefined();
    expect(r.ds).toBeDefined();
    expect(r.ti).toBeDefined();
    expect(r.gmgn).toBeDefined();
    expect(r.active_bin).toBe(1234);
  });

  it("score ties: order is stable (no crash)", () => {
    // Two identical candidates should produce same score — sort should not crash
    const a = makeCandidate();
    const b = makeCandidate();
    const ranked = rankCandidates([a, b]);
    expect(ranked.length).toBe(2);
    expect(ranked[0].rank_score).toBe(ranked[1].rank_score);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  3. pickBestCandidate
// ═════════════════════════════════════════════════════════════════════════════

describe("pickBestCandidate", () => {
  it("passes when score >= threshold", () => {
    const ranked = rankCandidates([makeCandidate()]);
    const result = pickBestCandidate(ranked, 0);
    expect(result).not.toBeNull();
    expect(result.candidate).toBe(ranked[0]);
    expect(result.score).toBe(ranked[0].rank_score);
    expect(result.breakdown).toEqual(ranked[0].rank_breakdown);
  });

  it("returns null when all candidates below threshold", () => {
    const minimal = makeCandidate({
      pool: { fee_active_tvl_ratio: 0, organic_score: 0, volume_window: 0, is_rugpull: true },
      sw: { in_pool: [] },
      n: { narrative: "" },
      ds: { ds_price_change_1h: -10 },
    });
    const ranked = rankCandidates([minimal]);
    const result = pickBestCandidate(ranked, 999);
    expect(result).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(pickBestCandidate([])).toBeNull();
  });

  it("returns null for null input", () => {
    expect(pickBestCandidate(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(pickBestCandidate(undefined)).toBeNull();
  });

  it("default threshold is 55", () => {
    const ranked = rankCandidates([makeCandidate()]);
    const score = ranked[0].rank_score;
    const result = pickBestCandidate(ranked);
    if (score >= 55) {
      expect(result).not.toBeNull();
    } else {
      expect(result).toBeNull();
    }
  });

  it("exact threshold boundary: score === threshold → passes", () => {
    const ranked = rankCandidates([makeCandidate()]);
    const exactScore = ranked[0].rank_score;
    const result = pickBestCandidate(ranked, exactScore);
    expect(result).not.toBeNull();
  });

  it("one below threshold → null", () => {
    const ranked = rankCandidates([makeCandidate()]);
    const exactScore = ranked[0].rank_score;
    const result = pickBestCandidate(ranked, exactScore + 1);
    expect(result).toBeNull();
  });

  it("returns correct candidate object with score and breakdown", () => {
    const ranked = rankCandidates([
      makeCandidate({ pool: { fee_active_tvl_ratio: 9 } }),
      makeCandidate({ pool: { fee_active_tvl_ratio: 1 } }),
    ]);
    const result = pickBestCandidate(ranked, 0);
    expect(result).not.toBeNull();
    expect(result.candidate.pool.fee_active_tvl_ratio).toBe(9);
    expect(typeof result.score).toBe("number");
    expect(typeof result.breakdown).toBe("object");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  4. computeDeployArgs
// ═════════════════════════════════════════════════════════════════════════════

describe("computeDeployArgs", () => {
  function rankedCandidate(overrides = {}) {
    const c = makeCandidate(overrides);
    const ranked = rankCandidates([c]);
    return ranked[0];
  }

  it("returns correct deploy_position shape", () => {
    const candidate = rankedCandidate();
    const args = computeDeployArgs(candidate, 0.5, 1234, {
      strategy: { minBinsBelow: 35, maxBinsBelow: 69 },
    });

    expect(args).toHaveProperty("pool_address");
    expect(args).toHaveProperty("pool_name");
    expect(args).toHaveProperty("active_bin");
    expect(args).toHaveProperty("amount_y");
    expect(args).toHaveProperty("amount_x");
    expect(args).toHaveProperty("bins_below");
    expect(args).toHaveProperty("bins_above");
    expect(args).toHaveProperty("volatility");
    expect(args).toHaveProperty("reason");
  });

  it("amount_y = deployAmount, amount_x = 0, bins_above = 0", () => {
    const candidate = rankedCandidate();
    const args = computeDeployArgs(candidate, 1.5, 5000, {
      strategy: { minBinsBelow: 35, maxBinsBelow: 69 },
    });

    expect(args.amount_y).toBe(1.5);
    expect(args.amount_x).toBe(0);
    expect(args.bins_above).toBe(0);
  });

  it("pool_address, pool_name, active_bin match input", () => {
    const candidate = rankedCandidate();
    const args = computeDeployArgs(candidate, 0.5, 9999, {
      strategy: { minBinsBelow: 35, maxBinsBelow: 69 },
    });

    expect(args.pool_address).toBe("test-pool-address");
    expect(args.pool_name).toBe("TEST-SOL");
    expect(args.active_bin).toBe(9999);
  });

  it("volatility matches candidate pool volatility", () => {
    const candidate = rankedCandidate();
    const args = computeDeployArgs(candidate, 0.5, 1234, {
      strategy: { minBinsBelow: 35, maxBinsBelow: 69 },
    });
    expect(args.volatility).toBe(4.5);
  });

  it("bins_below: volatility=0 → minBinsBelow", () => {
    const candidate = rankedCandidate({ pool: { volatility: 0 } });
    const args = computeDeployArgs(candidate, 0.5, 1234, {
      strategy: { minBinsBelow: 10, maxBinsBelow: 50 },
    });
    // rawBinsBelow = 10 + (0/5)*40 = 10
    expect(args.bins_below).toBe(10);
  });

  it("bins_below: volatility=5 → maxBinsBelow (full range reached)", () => {
    const candidate = rankedCandidate({ pool: { volatility: 5 } });
    const args = computeDeployArgs(candidate, 0.5, 1234, {
      strategy: { minBinsBelow: 10, maxBinsBelow: 50 },
    });
    // rawBinsBelow = 10 + (5/5)*40 = 50
    expect(args.bins_below).toBe(50);
  });

  it("bins_below: volatility=10 → clamped to maxBinsBelow", () => {
    const candidate = rankedCandidate({ pool: { volatility: 10 } });
    const args = computeDeployArgs(candidate, 0.5, 1234, {
      strategy: { minBinsBelow: 10, maxBinsBelow: 50 },
    });
    // rawBinsBelow = 10 + (10/5)*40 = 90 → clamped to 50
    expect(args.bins_below).toBe(50);
  });

  it("bins_below: low volatility (0.01) → clamped to minBinsBelow", () => {
    const candidate = rankedCandidate({ pool: { volatility: 0.01 } });
    const args = computeDeployArgs(candidate, 0.5, 1234, {
      strategy: { minBinsBelow: 35, maxBinsBelow: 69 },
    });
    // rawBinsBelow = 35 + (0.01/5)*34 = 35 + 0.068 = 35.068 → round = 35
    expect(args.bins_below).toBe(35);
  });

  it("bins_below: high volatility (100) → clamped to maxBinsBelow", () => {
    const candidate = rankedCandidate({ pool: { volatility: 100 } });
    const args = computeDeployArgs(candidate, 0.5, 1234, {
      strategy: { minBinsBelow: 35, maxBinsBelow: 69 },
    });
    expect(args.bins_below).toBe(69);
  });

  it("uses candidate.rank_score (not re-scoring)", () => {
    const candidate = rankedCandidate();
    const originalScore = candidate.rank_score;
    const args = computeDeployArgs(candidate, 0.5, 1234, {
      strategy: { minBinsBelow: 35, maxBinsBelow: 69 },
    });
    expect(args.reason).toContain(`score=${Math.round(originalScore)}`);
  });

  it("uses candidate.rank_breakdown (not re-scoring)", () => {
    const candidate = rankedCandidate();
    const args = computeDeployArgs(candidate, 0.5, 1234, {
      strategy: { minBinsBelow: 35, maxBinsBelow: 69 },
    });
    // Verify reason contains top signals from breakdown
    const topSignals = Object.entries(candidate.rank_breakdown)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${k}:${Math.round(v)}`)
      .join(", ");
    expect(args.reason).toContain(`top_signals=[${topSignals}]`);
  });

  it("missing volatility → defaults to 0.01", () => {
    const candidate = rankedCandidate({ pool: { volatility: undefined } });
    const args = computeDeployArgs(candidate, 0.5, 1234, {
      strategy: { minBinsBelow: 10, maxBinsBelow: 50 },
    });
    expect(args.volatility).toBe(0.01);
  });

  it("missing config.strategy → defaults to min=10, max=50", () => {
    const candidate = rankedCandidate({ pool: { volatility: 5 } });
    const args = computeDeployArgs(candidate, 0.5, 1234, {});
    // rawBinsBelow = 10 + (5/5)*40 = 50
    expect(args.bins_below).toBe(50);
  });

  it("null config → doesn't crash, uses defaults", () => {
    const candidate = rankedCandidate();
    const args = computeDeployArgs(candidate, 0.5, 1234, null);
    expect(args.bins_below).toBeGreaterThanOrEqual(10);
    expect(args.bins_below).toBeLessThanOrEqual(50);
  });

  it("null candidate.pool → doesn't crash", () => {
    const candidate = { rank_score: 50, rank_breakdown: { fee_tvl: 50 } };
    const args = computeDeployArgs(candidate, 0.5, 1234, {
      strategy: { minBinsBelow: 10, maxBinsBelow: 50 },
    });
    expect(args.pool_address).toBe("");
    expect(args.pool_name).toBe("");
    expect(args.volatility).toBe(0.01);
  });

  it("reason string contains score and top signals", () => {
    const candidate = rankedCandidate();
    const args = computeDeployArgs(candidate, 0.5, 1234, {
      strategy: { minBinsBelow: 35, maxBinsBelow: 69 },
    });
    expect(args.reason).toMatch(/score=\d+/);
    expect(args.reason).toContain("top_signals=[");
  });

  it("missing rank_score → reason uses 0", () => {
    const candidate = { pool: { pool: "x", name: "Y", volatility: 5 } };
    const args = computeDeployArgs(candidate, 0.5, 1234, {
      strategy: { minBinsBelow: 10, maxBinsBelow: 50 },
    });
    expect(args.reason).toContain("score=0");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  5. Integration / edge scenarios
// ═════════════════════════════════════════════════════════════════════════════

describe("Integration / edge scenarios", () => {
  it("candidate with ALL signals perfect → score near 100", () => {
    const perfect = makeCandidate({
      pool: { fee_active_tvl_ratio: 10, organic_score: 100, volume_window: 100000, risk_level: "LOW", is_rugpull: false, is_wash: false },
      sw: {
        in_pool: [
          { name: "KOL1", category: "kol", address: "0x1" },
          { name: "LP1", category: "lp", address: "0x2" },
        ],
      },
      n: { narrative: "viral meme" },
      ds: { ds_price_change_1h: 5 },
    });
    const { score, breakdown } = computeRankScore(perfect);
    // fee_tvl=100, smart_wallets=80+20=100, narrative=70, organic=100, volume=100, risk=80, momentum=100
    // weighted = 100*0.25 + 100*0.20 + 70*0.15 + 100*0.10 + 100*0.10 + 80*0.10 + 100*0.10
    //         = 25 + 20 + 10.5 + 10 + 10 + 8 + 10 = 93.5
    expect(score).toBe(93.5);
    expect(breakdown.fee_tvl).toBe(100);
    expect(breakdown.smart_wallets).toBe(100);
    expect(breakdown.narrative).toBe(70);
    expect(breakdown.organic).toBe(100);
    expect(breakdown.volume).toBe(100);
    expect(breakdown.risk).toBe(80);
    expect(breakdown.momentum).toBe(100);
  });

  it("candidate with ALL signals worst → score 0", () => {
    const worst = makeCandidate({
      pool: {
        fee_active_tvl_ratio: 0, organic_score: 0, volume_window: 0,
        risk_level: "HIGH", is_rugpull: true, is_wash: true,
      },
      sw: { in_pool: [] },
      n: { narrative: "" },
      ds: { ds_price_change_1h: -10 },
    });
    const { score, breakdown } = computeRankScore(worst);
    // fee_tvl=0, smart_wallets=0, narrative=0, organic=0, volume=0, risk=0, momentum=0
    expect(score).toBe(0);
    expect(breakdown.fee_tvl).toBe(0);
    expect(breakdown.smart_wallets).toBe(0);
    expect(breakdown.narrative).toBe(0);
    expect(breakdown.organic).toBe(0);
    expect(breakdown.volume).toBe(0);
    expect(breakdown.risk).toBe(0);
    expect(breakdown.momentum).toBe(0);
  });

  it("score ordering: higher fee_tvl + SW beats lower fee_tvl alone", () => {
    const highFeeAlone = makeCandidate({
      pool: { fee_active_tvl_ratio: 7 },
      sw: { in_pool: [] },
      n: { narrative: "" },
    });
    const midFeeWithSW = makeCandidate({
      pool: { fee_active_tvl_ratio: 4 },
      sw: { in_pool: [{ name: "W1", category: "kol", address: "0x1" }] },
      n: { narrative: "something" },
    });
    const scoreAlone = computeRankScore(highFeeAlone).score;
    const scoreWithSW = computeRankScore(midFeeWithSW).score;
    // midFeeWithSW should win because of SW + narrative boost
    expect(scoreWithSW).toBeGreaterThan(scoreAlone);
  });

  it("rankCandidates + pickBestCandidate end-to-end flow", () => {
    const candidates = [
      makeCandidate({ pool: { fee_active_tvl_ratio: 1 } }),
      makeCandidate({ pool: { fee_active_tvl_ratio: 8 } }),
      makeCandidate({ pool: { fee_active_tvl_ratio: 4 } }),
    ];
    const ranked = rankCandidates(candidates);
    expect(ranked.length).toBe(3);

    // Highest should be first
    expect(ranked[0].pool.fee_active_tvl_ratio).toBe(8);

    // pickBest should return the best one
    const best = pickBestCandidate(ranked, 0);
    expect(best).not.toBeNull();
    expect(best.candidate.pool.fee_active_tvl_ratio).toBe(8);
  });

  it("multiple candidates: pickBest returns the right one", () => {
    const low = makeCandidate({ pool: { fee_active_tvl_ratio: 0.5 } });
    const high = makeCandidate({ pool: { fee_active_tvl_ratio: 9.0 } });
    const ranked = rankCandidates([low, high]);
    const best = pickBestCandidate(ranked, 0);
    expect(best).not.toBeNull();
    expect(best.candidate.pool.fee_active_tvl_ratio).toBe(9.0);
    expect(best.score).toBe(ranked[0].rank_score);
  });

  it("KOL bonus: 1 KOL SW scores same as 2 non-KOL SW", () => {
    const oneKol = makeCandidate({
      sw: { in_pool: [{ name: "KOL", category: "kol", address: "0xK" }] },
    });
    const twoLp = makeCandidate({
      sw: {
        in_pool: [
          { name: "W1", category: "lp", address: "0x1" },
          { name: "W2", category: "lp", address: "0x2" },
        ],
      },
    });
    // 1 KOL: 60+20=80, 2 LP: 80+0=80
    expect(computeRankScore(oneKol).breakdown.smart_wallets).toBe(80);
    expect(computeRankScore(twoLp).breakdown.smart_wallets).toBe(80);
    // Same smart_wallets score, so total should be equal when only that differs
    expect(computeRankScore(oneKol).score).toBe(computeRankScore(twoLp).score);
  });

  it("volume edge: 0 volume → 0 (Math.max(1,0)=1, log10(1)*20=0)", () => {
    const c = makeCandidate({ pool: { volume_window: 0 } });
    expect(computeRankScore(c).breakdown.volume).toBe(0);
  });

  it("organic: NaN → 0 (NaN||0 = 0 since NaN is falsy)", () => {
    const c = makeCandidate({ pool: { organic_score: NaN } });
    // Number(NaN || 0) = Number(0) = 0 → organic = 0
    expect(computeRankScore(c).breakdown.organic).toBe(0);
  });

  it("computeDeployArgs end-to-end: full flow from raw candidate to deploy args", () => {
    const candidate = makeCandidate({
      pool: { volatility: 3.0 },
    });
    const ranked = rankCandidates([candidate]);
    const best = pickBestCandidate(ranked, 0);
    expect(best).not.toBeNull();

    const args = computeDeployArgs(best.candidate, 2.0, 5678, {
      strategy: { minBinsBelow: 20, maxBinsBelow: 80 },
    });

    expect(args.pool_address).toBe("test-pool-address");
    expect(args.amount_y).toBe(2.0);
    expect(args.active_bin).toBe(5678);
    // rawBinsBelow = 20 + (3/5)*60 = 20 + 36 = 56
    expect(args.bins_below).toBe(56);
    expect(args.reason).toContain(`score=${Math.round(best.score)}`);
  });
});
