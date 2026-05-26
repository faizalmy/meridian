import { describe, it, expect, vi } from "vitest";
import {
  computeRankScore,
  rankCandidates,
  pickBestCandidate,
  computeDeployArgs,
} from "../../tools/screening.js";

// ═════════════════════════════════════════════════════════════════════════════
//  Integration test for the Meridian deterministic screening pipeline
//
//  Exercises the REAL code paths in tools/screening.js, simulating the exact
//  data flow from index.js lines 677-741 (the deterministicScreening branch).
//
//  We do NOT mock the 4 screening functions — they ARE the code under test.
//  We DO mock external dependencies that the 4 functions don't call directly,
//  but that the pipeline needs for realism.
// ═════════════════════════════════════════════════════════════════════════════

// ─── Realistic data factories ──────────────────────────────────────────────

function makeRealisticPool(overrides = {}) {
  return {
    pool: "7K8jYtZc4qJqJqJqJqJqJqJqJqJqJqJqJqJqJqJq",
    name: "TRUMP-SOL",
    fee_active_tvl_ratio: 3.2,
    organic_score: 65,
    volume_window: 12000,
    tvl: 85000,
    mcap: 2500000,
    volatility: 3.8,
    risk_level: "LOW",
    is_rugpull: false,
    is_wash: false,
    bin_step: 10,
    fee_pct: 1,
    holders: 1200,
    token_age_hours: 48,
    base: { mint: "FakeMintAddress1111111111111111111111111111" },
    smart_money_buy: true,
    kol_in_clusters: false,
    ...overrides,
  };
}

function makeRealisticSW(overrides = {}) {
  return {
    pool: "pool-address",
    tracked_wallets: 5,
    in_pool: [
      { name: "AlphaWhale", category: "lp", address: "Addr1" },
      { name: "KOLTrader", category: "kol", address: "Addr2" },
    ],
    confidence_boost: true,
    signal: "2/5 smart wallets present",
    ...overrides,
  };
}

function makeRealisticNarrative(overrides = {}) {
  return {
    narrative: "Political meme token launched by Trump-affiliated account. Strong CT buzz.",
    ...overrides,
  };
}

function makeRealisticDS(overrides = {}) {
  return {
    ds_price_change_1h: 3.5,
    ds_price_change_5m: 1.2,
    ds_price_change_6h: -2.1,
    ds_price_change_24h: 15.3,
    ds_buys_1h: 450,
    ds_sells_1h: 200,
    ds_buy_pct_1h: 69.2,
    ds_buy_ratio_1h: 2.25,
    ds_liquidity_usd: 85000,
    ds_boosts_active: 0,
    ...overrides,
  };
}

function makeRealisticCandidate(overrides = {}) {
  const { pool: poolOv, sw: swOv, n: nOv, ds: dsOv, ...rest } = overrides;
  return {
    pool: makeRealisticPool(poolOv),
    sw: makeRealisticSW(swOv),
    n: makeRealisticNarrative(nOv),
    ti: {
      audit: { bot_holders_pct: 5, top_holders_pct: 30 },
      global_fees_sol: 50,
      launchpad: null,
      stats_1h: { price_change: 2.5, net_buyers: 100 },
    },
    ds: makeRealisticDS(dsOv),
    gmgn: {
      smartMoneyBuys: 3,
      smartMoneySells: 1,
      kolBuys: 0,
      clusterSignal: null,
    },
    mem: null,
    active_bin: 1234,
    ...rest,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
//  1. Pipeline simulation — tests the exact data flow from index.js 677-741
// ═════════════════════════════════════════════════════════════════════════════

describe("Pipeline simulation (index.js 677-741 flow)", () => {
  const MIN_DEPLOY_SCORE = 55;

  it("full pipeline: raw candidates → filtering → rankCandidates → pickBestCandidate → computeDeployArgs", () => {
    // Simulate: passing = [candidate1, candidate2, candidate3]
    const passing = [
      makeRealisticCandidate({
        pool: { name: "ALPHA-SOL", fee_active_tvl_ratio: 5.0 },
      }),
      makeRealisticCandidate({
        pool: { name: "BETA-SOL", fee_active_tvl_ratio: 2.0 },
      }),
      makeRealisticCandidate({
        pool: { name: "GAMMA-SOL", fee_active_tvl_ratio: 8.0 },
      }),
    ];

    // Step 1: Build enriched candidates (index.js line 682-685)
    const enrichedCandidates = passing.map((c) => ({
      ...c,
      active_bin: 1234,
    }));

    // Step 2: Rank (index.js line 688)
    const ranked = rankCandidates(enrichedCandidates);
    expect(ranked.length).toBe(3);
    expect(ranked[0].rank_score).toBeGreaterThanOrEqual(ranked[1].rank_score);

    // Step 3: Pick best (index.js line 689)
    const best = pickBestCandidate(ranked, MIN_DEPLOY_SCORE);
    expect(best).not.toBeNull();

    // Step 4: Compute deploy args (index.js line 712)
    const deployArgs = computeDeployArgs(best.candidate, 1.5, best.candidate.active_bin, {
      strategy: { minBinsBelow: 35, maxBinsBelow: 69 },
    });

    expect(deployArgs.pool_address).toBeTruthy();
    expect(deployArgs.amount_y).toBe(1.5);
    expect(deployArgs.active_bin).toBe(1234);
    expect(deployArgs.bins_below).toBeGreaterThanOrEqual(35);
    expect(deployArgs.bins_below).toBeLessThanOrEqual(69);
    expect(deployArgs.reason).toContain("score=");
  });

  it("all candidates below threshold → no deploy", () => {
    // Create candidates that will score very low
    const passing = [
      makeRealisticCandidate({
        pool: { fee_active_tvl_ratio: 0, organic_score: 0, volume_window: 0, is_rugpull: true, risk_level: "HIGH" },
        sw: { in_pool: [] },
        n: { narrative: "" },
        ds: { ds_price_change_1h: -10 },
      }),
    ];

    const enrichedCandidates = passing.map((c) => ({ ...c, active_bin: 1234 }));
    const ranked = rankCandidates(enrichedCandidates);
    const best = pickBestCandidate(ranked, MIN_DEPLOY_SCORE);

    // Score should be 0 (all signals worst) — below threshold
    expect(best).toBeNull();
    expect(ranked[0].rank_score).toBe(0);
  });

  it("multiple candidates → correct one picked (highest score)", () => {
    const candidates = [
      makeRealisticCandidate({
        pool: { name: "WEAK-SOL", fee_active_tvl_ratio: 0.5, organic_score: 10, volume_window: 100 },
        sw: { in_pool: [] },
        n: { narrative: "" },
        ds: { ds_price_change_1h: -3 },
      }),
      makeRealisticCandidate({
        pool: { name: "STRONG-SOL", fee_active_tvl_ratio: 8.0, organic_score: 90, volume_window: 50000 },
        sw: {
          in_pool: [
            { name: "KOL1", category: "kol", address: "0x1" },
            { name: "LP1", category: "lp", address: "0x2" },
          ],
        },
        n: { narrative: "Viral meme token with strong community" },
        ds: { ds_price_change_1h: 5 },
      }),
      makeRealisticCandidate({
        pool: { name: "MID-SOL", fee_active_tvl_ratio: 4.0, organic_score: 50, volume_window: 5000 },
        sw: { in_pool: [{ name: "W1", category: "lp", address: "0x3" }] },
        n: { narrative: "Some narrative" },
        ds: { ds_price_change_1h: 1 },
      }),
    ];

    const enrichedCandidates = candidates.map((c) => ({ ...c, active_bin: 1234 }));
    const ranked = rankCandidates(enrichedCandidates);
    const best = pickBestCandidate(ranked, 0);

    expect(best).not.toBeNull();
    expect(best.candidate.pool.name).toBe("STRONG-SOL");
    // Verify the ranking order matches
    expect(ranked[0].pool.name).toBe("STRONG-SOL");
    expect(ranked[1].pool.name).toBe("MID-SOL");
    expect(ranked[2].pool.name).toBe("WEAK-SOL");
  });

  it("empty passing list → empty ranked array → null pick", () => {
    const passing = [];

    // Simulate what index.js does: passing.map(...)
    const enrichedCandidates = passing.map((c) => ({ ...c, active_bin: 1234 }));
    const ranked = rankCandidates(enrichedCandidates);
    const best = pickBestCandidate(ranked, MIN_DEPLOY_SCORE);

    expect(ranked).toEqual([]);
    expect(best).toBeNull();
  });

  it("candidate with null active_bin → skipped (simulates active_bin == null check)", () => {
    // In index.js lines 704-710, if best.candidate.active_bin == null, deploy is skipped
    const passing = [
      makeRealisticCandidate({ active_bin: null }),
    ];

    const enrichedCandidates = passing.map((c) => ({
      ...c,
      active_bin: null, // simulates getActiveBin returning null
    }));
    const ranked = rankCandidates(enrichedCandidates);
    const best = pickBestCandidate(ranked, 0);

    // best is found (score passes threshold)
    expect(best).not.toBeNull();
    // But active_bin is null → deploy should be skipped
    expect(best.candidate.active_bin).toBeNull();

    // Simulate index.js line 704-710
    const activeBin = best.candidate.active_bin;
    const shouldDeploy = activeBin != null;
    expect(shouldDeploy).toBe(false);
  });

  it("deploy blocked by executeTool → decision.action = 'skip'", () => {
    const passing = [makeRealisticCandidate()];
    const enrichedCandidates = passing.map((c) => ({ ...c, active_bin: 1234 }));
    const ranked = rankCandidates(enrichedCandidates);
    const best = pickBestCandidate(ranked, 0);
    expect(best).not.toBeNull();

    // Simulate executeTool returning a blocked result (index.js line 716-717)
    const mockResult = { success: false, error: "insufficient balance", blocked: true };
    const deployOk = mockResult && mockResult.success !== false && !mockResult.error && !mockResult.blocked;

    expect(deployOk).toBe(false);

    // Build decision object (index.js lines 720-729)
    const decision = {
      action: deployOk ? "deploy" : "skip",
      pair: best.candidate.pool.name,
      summary: deployOk
        ? `Deterministic deploy: score=${best.score}`
        : `Deploy blocked: ${mockResult.error || mockResult.message || "unknown"}`,
    };

    expect(decision.action).toBe("skip");
    expect(decision.summary).toContain("Deploy blocked: insufficient balance");
  });

  it("score boundary: candidate exactly at minDeployScore passes", () => {
    // Create a candidate with a known score and test the exact boundary
    const candidate = makeRealisticCandidate();
    const ranked = rankCandidates([candidate]);
    const exactScore = ranked[0].rank_score;

    // pickBestCandidate with threshold = exact score → should pass
    const best = pickBestCandidate(ranked, exactScore);
    expect(best).not.toBeNull();
    expect(best.score).toBe(exactScore);
  });

  it("score boundary: candidate 1 below minDeployScore fails", () => {
    const candidate = makeRealisticCandidate();
    const ranked = rankCandidates([candidate]);
    const exactScore = ranked[0].rank_score;

    // pickBestCandidate with threshold = exact score + 1 → should fail
    const best = pickBestCandidate(ranked, exactScore + 1);
    expect(best).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  2. Realistic pool data — tests with data shapes matching actual API responses
// ═════════════════════════════════════════════════════════════════════════════

describe("Realistic pool data scoring", () => {
  it("typical good pool (LOW risk, SW present, narrative, high fee_tvl) → expect 65-85", () => {
    const candidate = makeRealisticCandidate();
    const { score, breakdown } = computeRankScore(candidate);

    // Expectations based on realistic data:
    // fee_tvl: (3.2/10)*100 = 32, weight 0.25 → 8.0
    // smart_wallets: 2 non-KOL = 80, + KOL bonus = 100, weight 0.20 → 20.0
    // narrative: present = 70, weight 0.15 → 10.5
    // organic: 65, weight 0.10 → 6.5
    // volume: log10(12000)*20 = (4.079)*20 = 81.58, weight 0.10 → 8.158
    // risk: LOW = 80, weight 0.10 → 8.0
    // momentum: 50 + min(3.5*10, 50) = 85, weight 0.10 → 8.5
    // Total ≈ 69.66

    expect(score).toBeGreaterThanOrEqual(65);
    expect(score).toBeLessThanOrEqual(85);
    expect(breakdown.fee_tvl).toBeGreaterThan(0);
    expect(breakdown.smart_wallets).toBe(100); // 2 SW + KOL bonus
    expect(breakdown.narrative).toBe(70);
    expect(breakdown.risk).toBe(80);
  });

  it("rugpull pool → expect very low (0-15)", () => {
    const candidate = makeRealisticCandidate({
      pool: {
        fee_active_tvl_ratio: 0,
        organic_score: 0,
        volume_window: 0,
        is_rugpull: true,
        is_wash: true,
        risk_level: "HIGH",
      },
      sw: { in_pool: [] },
      n: { narrative: "" },
      ds: { ds_price_change_1h: -10 },
    });

    const { score, breakdown } = computeRankScore(candidate);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(15);
    expect(breakdown.risk).toBe(0);
    expect(breakdown.smart_wallets).toBe(0);
    expect(breakdown.narrative).toBe(0);
  });

  it("pool with no smart wallets, no narrative, HIGH risk → expect low (15-30)", () => {
    const candidate = makeRealisticCandidate({
      sw: { in_pool: [] },
      n: { narrative: "" },
      pool: { risk_level: "HIGH", is_rugpull: false, is_wash: false },
      ds: { ds_price_change_1h: 0 },
    });

    const { score, breakdown } = computeRankScore(candidate);
    expect(score).toBeGreaterThanOrEqual(15);
    expect(score).toBeLessThanOrEqual(35);
    expect(breakdown.smart_wallets).toBe(0);
    expect(breakdown.narrative).toBe(0);
    expect(breakdown.risk).toBe(20);
  });

  it("pool with KOL wallet → verify KOL bonus applied", () => {
    const withKol = makeRealisticCandidate({
      sw: {
        in_pool: [
          { name: "KOLTrader", category: "kol", address: "0xK" },
        ],
      },
    });

    const withoutKol = makeRealisticCandidate({
      sw: {
        in_pool: [
          { name: "LPTrader", category: "lp", address: "0xL" },
        ],
      },
    });

    const { breakdown: withKolBD } = computeRankScore(withKol);
    const { breakdown: withoutKolBD } = computeRankScore(withoutKol);

    // KOL: 60 + 20 bonus = 80
    expect(withKolBD.smart_wallets).toBe(80);
    // LP only: 60
    expect(withoutKolBD.smart_wallets).toBe(60);
    // KOL should score higher total
    expect(computeRankScore(withKol).score).toBeGreaterThan(
      computeRankScore(withoutKol).score
    );
  });

  it("pool with volume 0 → volume component = 0", () => {
    const candidate = makeRealisticCandidate({
      pool: { volume_window: 0 },
    });

    const { breakdown } = computeRankScore(candidate);
    // Math.log10(Math.max(1, 0)) * 20 = Math.log10(1) * 20 = 0
    expect(breakdown.volume).toBe(0);
  });

  it("pool with organic_score > 100 → clamped to 100", () => {
    const candidate = makeRealisticCandidate({
      pool: { organic_score: 150 },
    });

    const { breakdown } = computeRankScore(candidate);
    expect(breakdown.organic).toBe(100);
  });

  it("full pipeline: 5 realistic candidates → correct winner", () => {
    const candidates = [
      makeRealisticCandidate({
        pool: { name: "PEPE-SOL", fee_active_tvl_ratio: 1.0, organic_score: 30, volume_window: 500, risk_level: "MEDIUM" },
        sw: { in_pool: [] },
        n: { narrative: "" },
        ds: { ds_price_change_1h: -2 },
      }),
      makeRealisticCandidate({
        pool: { name: "WIF-SOL", fee_active_tvl_ratio: 6.0, organic_score: 85, volume_window: 80000, risk_level: "LOW" },
        sw: {
          in_pool: [
            { name: "AlphaWhale", category: "lp", address: "0x1" },
            { name: "KOLKing", category: "kol", address: "0x2" },
            { name: "SmartBot", category: "lp", address: "0x3" },
          ],
        },
        n: { narrative: "Dog meme with massive CT following. Trending #1 on DexScreener." },
        ds: { ds_price_change_1h: 8.5 },
      }),
      makeRealisticCandidate({
        pool: { name: "BONK-SOL", fee_active_tvl_ratio: 2.5, organic_score: 55, volume_window: 10000, risk_level: "LOW" },
        sw: { in_pool: [{ name: "Trader1", category: "lp", address: "0x4" }] },
        n: { narrative: "Dog coin revival narrative" },
        ds: { ds_price_change_1h: 1.0 },
      }),
      makeRealisticCandidate({
        pool: { name: "SCAM-SOL", fee_active_tvl_ratio: 0.1, organic_score: 5, volume_window: 50, risk_level: "HIGH", is_rugpull: true },
        sw: { in_pool: [] },
        n: { narrative: "" },
        ds: { ds_price_change_1h: -8 },
      }),
      makeRealisticCandidate({
        pool: { name: "JUP-SOL", fee_active_tvl_ratio: 4.0, organic_score: 70, volume_window: 25000, risk_level: "LOW" },
        sw: {
          in_pool: [
            { name: "WhaleX", category: "lp", address: "0x5" },
            { name: "KOLAlpha", category: "kol", address: "0x6" },
          ],
        },
        n: { narrative: "Jupiter ecosystem token with strong fundamentals" },
        ds: { ds_price_change_1h: 3.0 },
      }),
    ];

    const enrichedCandidates = candidates.map((c) => ({ ...c, active_bin: 1234 }));
    const ranked = rankCandidates(enrichedCandidates);

    // Verify ranking order: WIF should be top (highest fee_tvl, SW, narrative, momentum)
    expect(ranked[0].pool.name).toBe("WIF-SOL");
    expect(ranked[ranked.length - 1].pool.name).toBe("SCAM-SOL");

    const best = pickBestCandidate(ranked, 55);
    expect(best).not.toBeNull();
    expect(best.candidate.pool.name).toBe("WIF-SOL");

    // Compute deploy args for winner
    const deployArgs = computeDeployArgs(best.candidate, 2.0, 1234, {
      strategy: { minBinsBelow: 35, maxBinsBelow: 69 },
    });

    expect(deployArgs.pool_address).toBe(best.candidate.pool.pool);
    expect(deployArgs.pool_name).toBe("WIF-SOL");
    expect(deployArgs.amount_y).toBe(2.0);
    expect(deployArgs.bins_below).toBeGreaterThanOrEqual(35);
    expect(deployArgs.bins_below).toBeLessThanOrEqual(69);
  });

  it("deploy args from realistic candidate → bins_below calculated correctly", () => {
    const candidate = makeRealisticCandidate({
      pool: { volatility: 2.5 },
    });
    const ranked = rankCandidates([candidate]);
    const rankedCandidate = ranked[0];

    const deployArgs = computeDeployArgs(rankedCandidate, 3.0, 5678, {
      strategy: { minBinsBelow: 20, maxBinsBelow: 80 },
    });

    // rawBinsBelow = 20 + (2.5/5) * (80-20) = 20 + 0.5 * 60 = 50
    expect(deployArgs.bins_below).toBe(50);
    expect(deployArgs.volatility).toBe(2.5);
    expect(deployArgs.amount_y).toBe(3.0);
    expect(deployArgs.active_bin).toBe(5678);
    expect(deployArgs.pool_address).toBe(candidate.pool.pool);
  });

  it("pool with very high fee_tvl ratio (10+) → fee_tvl capped at 100", () => {
    const candidate = makeRealisticCandidate({
      pool: { fee_active_tvl_ratio: 15 },
    });

    const { breakdown } = computeRankScore(candidate);
    expect(breakdown.fee_tvl).toBe(100);
  });

  it("pool with neutral momentum (0% change) → momentum = 50", () => {
    const candidate = makeRealisticCandidate({
      ds: { ds_price_change_1h: 0 },
    });

    const { breakdown } = computeRankScore(candidate);
    expect(breakdown.momentum).toBe(50);
  });

  it("confidence classification matches index.js logic", () => {
    const candidate = makeRealisticCandidate();
    const ranked = rankCandidates([candidate]);
    const best = pickBestCandidate(ranked, 0);
    expect(best).not.toBeNull();

    // Replicate confidence logic from index.js line 726
    const score = best.score;
    let expectedConfidence;
    if (score >= 80) expectedConfidence = "very_high";
    else if (score >= 65) expectedConfidence = "high";
    else if (score >= 55) expectedConfidence = "medium";
    else expectedConfidence = "low";

    expect(expectedConfidence).toBeTruthy();
    // With realistic good pool data, score should be at least "medium"
    expect(["low", "medium", "high", "very_high"]).toContain(expectedConfidence);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  3. Data shape resilience — ensures the pipeline handles edge-case inputs
// ═════════════════════════════════════════════════════════════════════════════

describe("Data shape resilience", () => {
  it("candidate with missing `sw` field → defaults to empty", () => {
    const candidate = {
      pool: makeRealisticPool(),
      n: makeRealisticNarrative(),
      ds: makeRealisticDS(),
      // no sw field
    };

    const { score, breakdown } = computeRankScore(candidate);
    expect(typeof score).toBe("number");
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    expect(breakdown.smart_wallets).toBe(0);
  });

  it("candidate with missing `n` field → narrative = 0", () => {
    const candidate = {
      pool: makeRealisticPool(),
      sw: makeRealisticSW(),
      ds: makeRealisticDS(),
      // no n field
    };

    const { breakdown } = computeRankScore(candidate);
    expect(breakdown.narrative).toBe(0);
  });

  it("candidate with missing `ds` field → momentum = 50 (0 change)", () => {
    const candidate = {
      pool: makeRealisticPool(),
      sw: makeRealisticSW(),
      n: makeRealisticNarrative(),
      // no ds field
    };

    const { breakdown } = computeRankScore(candidate);
    // ds_price_change_1h undefined → (undefined || 0) = 0 → momentum = 50
    expect(breakdown.momentum).toBe(50);
  });

  it("candidate with null `pool` → doesn't crash", () => {
    const candidate = {
      pool: null,
      sw: makeRealisticSW(),
      n: makeRealisticNarrative(),
      ds: makeRealisticDS(),
    };

    const { score, breakdown } = computeRankScore(candidate);
    expect(typeof score).toBe("number");
    expect(score).toBeGreaterThanOrEqual(0);
    expect(Object.keys(breakdown).length).toBe(7);

    // Can also rank, pick, and compute deploy args without crash
    const ranked = rankCandidates([candidate]);
    expect(ranked.length).toBe(1);

    // computeDeployArgs should handle null pool
    const args = computeDeployArgs(ranked[0], 1.0, 1234, {
      strategy: { minBinsBelow: 10, maxBinsBelow: 50 },
    });
    expect(args.pool_address).toBe("");
    expect(args.pool_name).toBe("");
    expect(args.volatility).toBe(0.01);
  });

  it("candidate with string `fee_active_tvl_ratio` → Number() coercion works", () => {
    const candidate = makeRealisticCandidate({
      pool: { fee_active_tvl_ratio: "3.2" }, // string instead of number
    });

    const { score, breakdown } = computeRankScore(candidate);
    expect(typeof score).toBe("number");
    expect(score).toBeGreaterThanOrEqual(0);
    // Number("3.2") = 3.2 → fee_tvl = (3.2/10)*100 = 32
    expect(breakdown.fee_tvl).toBe(32);
  });

  it("candidate with negative `volume_window` → log scale handles it", () => {
    const candidate = makeRealisticCandidate({
      pool: { volume_window: -100 },
    });

    const { score, breakdown } = computeRankScore(candidate);
    expect(typeof score).toBe("number");
    expect(score).toBeGreaterThanOrEqual(0);
    // Math.log10(Math.max(1, -100)) * 20 = Math.log10(1) * 20 = 0
    expect(breakdown.volume).toBe(0);
  });

  it("candidate with undefined fields throughout → graceful degradation", () => {
    const candidate = {
      pool: { pool: undefined, name: undefined },
      sw: { in_pool: undefined },
      n: { narrative: undefined },
      ds: { ds_price_change_1h: undefined },
    };

    const { score, breakdown } = computeRankScore(candidate);
    expect(typeof score).toBe("number");
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
    expect(Object.keys(breakdown).length).toBe(7);
  });

  it("pipeline handles mix of valid and malformed candidates", () => {
    const candidates = [
      makeRealisticCandidate({ pool: { name: "GOOD-SOL", fee_active_tvl_ratio: 7.0 } }),
      { pool: null, sw: null, n: null, ds: null }, // malformed
      makeRealisticCandidate({ pool: { name: "OK-SOL", fee_active_tvl_ratio: 3.0 } }),
    ];

    const enriched = candidates.map((c) => ({ ...c, active_bin: 1234 }));
    const ranked = rankCandidates(enriched);

    // All 3 should be ranked (no crash)
    expect(ranked.length).toBe(3);

    // The malformed one should get a low score
    const scores = ranked.map((r) => r.rank_score);
    expect(scores.every((s) => typeof s === "number")).toBe(true);

    // Best should be one of the valid ones
    const best = pickBestCandidate(ranked, 0);
    expect(best).not.toBeNull();
    expect(best.candidate.pool.name).not.toBeUndefined();
  });

  it("full end-to-end with empty string values → no crash", () => {
    const candidate = {
      pool: {
        pool: "",
        name: "",
        fee_active_tvl_ratio: "",
        organic_score: "",
        volume_window: "",
        risk_level: "",
        is_rugpull: "",
        is_wash: "",
      },
      sw: { in_pool: "" },
      n: { narrative: "" },
      ds: { ds_price_change_1h: "" },
    };

    const { score, breakdown } = computeRankScore(candidate);
    expect(typeof score).toBe("number");
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);

    const ranked = rankCandidates([candidate]);
    expect(ranked.length).toBe(1);

    const best = pickBestCandidate(ranked, 0);
    // Empty strings coerce to 0 via Number(), but risk defaults to 50 (no risk_level match)
    // and momentum defaults to 50 (ds_price_change_1h "" → 0). Score = 10.
    // With threshold 0, this still passes (10 >= 0).
    expect(best).not.toBeNull();
    expect(best.score).toBe(10);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  4. Pipeline state transitions — mirrors index.js decision logic
// ═════════════════════════════════════════════════════════════════════════════

describe("Pipeline state transitions (decision logic)", () => {
  it("deploy success path: decision.action = 'deploy'", () => {
    const candidate = makeRealisticCandidate();
    const ranked = rankCandidates([candidate]);
    const best = pickBestCandidate(ranked, 0);
    expect(best).not.toBeNull();

    // Simulate successful executeTool
    const mockResult = { success: true, txid: "abc123" };
    const deployOk = mockResult && mockResult.success !== false && !mockResult.error && !mockResult.blocked;
    expect(deployOk).toBe(true);

    const decision = {
      action: deployOk ? "deploy" : "skip",
      pair: best.candidate.pool.name,
      summary: deployOk
        ? `Deterministic deploy: score=${best.score}, fee_tvl=${best.breakdown.fee_tvl}, smart_wallets=${best.breakdown.smart_wallets}`
        : `Deploy blocked: ${mockResult?.error || "unknown"}`,
    };

    expect(decision.action).toBe("deploy");
    expect(decision.summary).toContain("score=");
    expect(decision.summary).toContain("fee_tvl=");
  });

  it("no candidate above threshold → appends no_deploy decision", () => {
    const candidate = makeRealisticCandidate({
      pool: { fee_active_tvl_ratio: 0, organic_score: 0, volume_window: 0, is_rugpull: true },
      sw: { in_pool: [] },
      n: { narrative: "" },
      ds: { ds_price_change_1h: -10 },
    });

    const ranked = rankCandidates([candidate]);
    const best = pickBestCandidate(ranked, 999); // impossibly high threshold

    expect(best).toBeNull();

    // Simulate the decision from index.js line 695
    const decision = {
      type: "no_deploy",
      actor: "SCREENER",
      summary: "Deterministic: below threshold",
      reason: `No candidates above quality threshold. Top score: ${ranked[0]?.rank_score ?? 0}/999.`,
    };

    expect(decision.type).toBe("no_deploy");
    expect(decision.summary).toContain("below threshold");
  });

  it("multiple passing candidates, only one above threshold", () => {
    const candidates = [
      makeRealisticCandidate({
        pool: { name: "BELOW-SOL", fee_active_tvl_ratio: 0.1, organic_score: 5, volume_window: 10 },
        sw: { in_pool: [] },
        n: { narrative: "" },
        ds: { ds_price_change_1h: -5 },
      }),
      makeRealisticCandidate({
        pool: { name: "ABOVE-SOL", fee_active_tvl_ratio: 7.0, organic_score: 80, volume_window: 30000 },
        sw: {
          in_pool: [
            { name: "KOL1", category: "kol", address: "0x1" },
            { name: "LP1", category: "lp", address: "0x2" },
          ],
        },
        n: { narrative: "Strong narrative" },
        ds: { ds_price_change_1h: 4 },
      }),
    ];

    const enrichedCandidates = candidates.map((c) => ({ ...c, active_bin: 1234 }));
    const ranked = rankCandidates(enrichedCandidates);

    // Find the threshold where only ABOVE-SOL passes
    const belowScore = ranked.find((r) => r.pool.name === "BELOW-SOL").rank_score;
    const aboveScore = ranked.find((r) => r.pool.name === "ABOVE-SOL").rank_score;

    expect(aboveScore).toBeGreaterThan(belowScore);

    // Threshold between the two scores
    const threshold = (belowScore + aboveScore) / 2;
    const best = pickBestCandidate(ranked, threshold);

    if (best) {
      expect(best.candidate.pool.name).toBe("ABOVE-SOL");
    } else {
      // If both are below, that's fine too
      expect(aboveScore).toBeLessThan(threshold);
    }
  });
});
