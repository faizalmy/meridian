/**
 * GMGN Track data module for Meridian.
 *
 * Fetches real-time smart money and KOL trades via gmgn-cli,
 * caches them, and detects cluster signals.
 *
 * Fail-open: if gmgn-cli fails or returns empty, returns empty arrays.
 * SOL-only by default (chain='sol').
 *
 * Cache: gmgn-cache.json with 5-minute TTL (matches DexScreener pattern).
 */

import { exec } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";

// ── Constants ─────────────────────────────────────────────────

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const CACHE_FILE = path.resolve("gmgn-cache.json");
const DEFAULT_LIMIT = 50;
const DEFAULT_WINDOW_MINUTES = 30;

// ── Injectable exec function (for testing) ────────────────────

let _execFn = promisify(exec);

/**
 * Override the exec function (for testing only).
 */
export function _setExecFn(fn) {
  _execFn = fn;
}

/**
 * Reset exec function to default (for testing only).
 */
export function _resetExecFn() {
  _execFn = promisify(exec);
}

// ── Rate Limiting ─────────────────────────────────────────────

let _bannedUntil = 0; // timestamp when ban expires

function isBanned() {
  return Date.now() < _bannedUntil;
}

function setBan(durationMs) {
  _bannedUntil = Date.now() + Math.min(durationMs, 5 * 60 * 1000); // cap at 5min
}

function clearBan() {
  _bannedUntil = 0;
}

// ── Cache ─────────────────────────────────────────────────────

let _cache = {
  smartMoneyTrades: { trades: [], lastFetched: null },
  kolTrades: { trades: [], lastFetched: null },
};

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.smartMoneyTrades && parsed.kolTrades) {
        _cache = parsed;
      }
    }
  } catch {
    // Corrupt cache — start fresh
    _cache = {
      smartMoneyTrades: { trades: [], lastFetched: null },
      kolTrades: { trades: [], lastFetched: null },
    };
  }
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(_cache, null, 2));
  } catch {
    // Non-fatal — cache write failed
  }
}

function isCacheFresh(key) {
  const entry = _cache[key];
  if (!entry || !entry.lastFetched) return false;
  return Date.now() - new Date(entry.lastFetched).getTime() < CACHE_TTL;
}

function setCache(key, trades) {
  _cache[key] = {
    trades,
    lastFetched: new Date().toISOString(),
  };
  saveCache();
}

/**
 * Clear all caches. Exported for testing only.
 */
export function clearGmgnCaches() {
  _cache = {
    smartMoneyTrades: { trades: [], lastFetched: null },
    kolTrades: { trades: [], lastFetched: null },
  };
  clearBan();
}

/**
 * Get current cache state. Exported for testing only.
 */
export function getCacheState() {
  return {
    smartMoneyTrades: { ..._cache.smartMoneyTrades },
    kolTrades: { ..._cache.kolTrades },
    bannedUntil: _bannedUntil,
  };
}

// ── gmgn-cli Runner ──────────────────────────────────────────

/**
 * Run a gmgn-cli command and parse JSON output.
 * Returns parsed JSON array/object on success, null on error.
 * Handles rate limiting (429/RATE_LIMIT_BANNED).
 */
async function runGmgnCli(args) {
  if (isBanned()) {
    return null;
  }

  const cmd = `gmgn-cli ${args} --raw`;

  try {
    const { stdout, stderr } = await _execFn(cmd, {
      timeout: 30_000,
      encoding: "utf8",
    });

    // Check for rate limit ban in stderr
    if (stderr && stderr.includes("RATE_LIMIT_BANNED")) {
      // Parse reset_at from error message
      const resetMatch = stderr.match(/reset_at['":\s]+(\d+)/);
      if (resetMatch) {
        const resetAt = parseInt(resetMatch[1], 10) * 1000; // seconds → ms
        const waitMs = Math.max(resetAt - Date.now(), 5000);
        setBan(waitMs);
      } else {
        setBan(30_000); // default 30s ban
      }
      return null;
    }

    // Check for 429 in stderr
    if (stderr && stderr.includes("429")) {
      setBan(10_000); // 10s ban on 429
      return null;
    }

    const trimmed = stdout.trim();
    if (!trimmed) return [];

    // gmgn-cli sometimes prefixes output with [gmgn-cli] messages
    // Find the first [ or { to locate JSON
    const jsonStart = trimmed.search(/[\[{]/);
    if (jsonStart === -1) return [];

    const jsonStr = trimmed.slice(jsonStart);
    return JSON.parse(jsonStr);
  } catch (err) {
    // Fail-open: return null on any error
    return null;
  }
}

// ── Public Exports ────────────────────────────────────────────

/**
 * Fetch smart money trades from GMGN.
 * Returns array of trade objects, or empty array on error.
 */
export async function fetchSmartMoneyTrades(chain = "sol", limit = DEFAULT_LIMIT) {
  loadCache();

  if (isCacheFresh("smartMoneyTrades")) {
    return _cache.smartMoneyTrades.trades;
  }

  const raw = await runGmgnCli(`track smartmoney --chain ${chain} --limit ${limit}`);

  // gmgn-cli returns { list: [...] } — extract the array
  const result = raw?.list ?? (Array.isArray(raw) ? raw : null);

  if (result === null || !Array.isArray(result)) {
    // On error, return stale cache if available
    return _cache.smartMoneyTrades.trades || [];
  }

  setCache("smartMoneyTrades", result);
  return result;
}

/**
 * Fetch KOL trades from GMGN.
 * Returns array of trade objects, or empty array on error.
 */
export async function fetchKolTrades(chain = "sol", limit = DEFAULT_LIMIT) {
  loadCache();

  if (isCacheFresh("kolTrades")) {
    return _cache.kolTrades.trades;
  }

  const raw = await runGmgnCli(`track kol --chain ${chain} --limit ${limit}`);

  // gmgn-cli returns { list: [...] } — extract the array
  const result = raw?.list ?? (Array.isArray(raw) ? raw : null);

  if (result === null || !Array.isArray(result)) {
    return _cache.kolTrades.trades || [];
  }

  setCache("kolTrades", result);
  return result;
}

/**
 * Detect cluster signals from trade data.
 * Groups trades by base_address and counts distinct makers per direction.
 *
 * Signal strength levels:
 *   - Weak: 1 KOL buy
 *   - Medium: 2-3 smart money same direction, or 1 full position open
 *   - Strong: 3+ smart money same direction within window
 *   - Very Strong: cluster + full position opens + KOL joining
 *
 * @param {Array} trades - Array of trade objects
 * @param {number} windowMinutes - Time window for clustering (default 30)
 * @returns {Array} Cluster signals
 */
export function detectClusterSignals(trades, windowMinutes = DEFAULT_WINDOW_MINUTES) {
  if (!trades || !trades.length) return [];

  const now = Date.now();
  const windowMs = windowMinutes * 60 * 1000;

  // Filter to trades within window
  const recentTrades = trades.filter((t) => {
    const tradeTime = new Date(t.timestamp || t.created_at || t.time).getTime();
    return !isNaN(tradeTime) && now - tradeTime <= windowMs;
  });

  if (!recentTrades.length) return [];

  // Group by base_address
  const byToken = {};
  for (const trade of recentTrades) {
    const token = trade.base_address || trade.token_address || trade.mint;
    if (!token) continue;

    if (!byToken[token]) {
      byToken[token] = { buys: [], sells: [] };
    }

    const isBuy =
      trade.side === "buy" ||
      trade.direction === "buy" ||
      trade.is_buy === true;
    const entry = {
      maker: trade.maker || trade.wallet || trade.user_address,
      usd: parseFloat(trade.usd_amount || trade.amount_usd || trade.value || "0"),
      isFullPosition:
        trade.is_full_position === true ||
        trade.position_type === "full",
      isKol: trade.is_kol === true || trade.source === "kol",
    };

    if (isBuy) {
      byToken[token].buys.push(entry);
    } else {
      byToken[token].sells.push(entry);
    }
  }

  // Analyze each token
  const signals = [];
  for (const [token, { buys, sells }] of Object.entries(byToken)) {
    // Count unique makers per direction
    const buyMakers = new Set(buys.map((b) => b.maker).filter(Boolean));
    const sellMakers = new Set(sells.map((s) => s.maker).filter(Boolean));

    const buyKols = buys.filter((b) => b.isKol);
    const sellKols = sells.filter((s) => s.isKol);

    const buyFullPositions = buys.filter((b) => b.isFullPosition);
    const sellFullPositions = sells.filter((s) => s.isFullPosition);

    const buyUsd = buys.reduce((sum, b) => sum + (b.usd || 0), 0);
    const sellUsd = sells.reduce((sum, s) => sum + (s.usd || 0), 0);

    // Determine buy signal strength
    let buySignal = "none";
    if (buyKols.length >= 1 && buyMakers.size >= 3 && buyFullPositions.length >= 1) {
      buySignal = "very_strong";
    } else if (buyMakers.size >= 3) {
      buySignal = "strong";
    } else if (buyMakers.size >= 2 || buyFullPositions.length >= 1) {
      buySignal = "medium";
    } else if (buyKols.length >= 1) {
      buySignal = "weak";
    }

    // Determine sell signal strength
    let sellSignal = "none";
    if (sellMakers.size >= 3) {
      sellSignal = "strong";
    } else if (sellMakers.size >= 2 || sellFullPositions.length >= 1) {
      sellSignal = "medium";
    }

    if (buySignal !== "none") {
      signals.push({
        token,
        direction: "buy",
        walletCount: buyMakers.size,
        totalUsd: buyUsd,
        signalStrength: buySignal,
        kolCount: buyKols.length,
        fullPositionCount: buyFullPositions.length,
      });
    }

    if (sellSignal !== "none") {
      signals.push({
        token,
        direction: "sell",
        walletCount: sellMakers.size,
        totalUsd: sellUsd,
        signalStrength: sellSignal,
        kolCount: sellKols.length,
        fullPositionCount: sellFullPositions.length,
      });
    }
  }

  return signals;
}

/**
 * Check GMGN signals for a specific token.
 * Returns aggregated signal data from cached trades.
 *
 * @param {string} mint - Token mint address
 * @returns {Object} Signal data for the token
 */
export async function checkGmgnSignals(mint) {
  if (!mint) {
    return {
      smartMoneyBuys: 0,
      smartMoneySells: 0,
      kolBuys: 0,
      clusterSignal: null,
      recentTrades: [],
    };
  }

  const [smartMoneyTrades, kolTrades] = await Promise.all([
    fetchSmartMoneyTrades(),
    fetchKolTrades(),
  ]);

  // Filter trades for this token
  const allTrades = [...smartMoneyTrades, ...kolTrades];
  const tokenTrades = allTrades.filter((t) => {
    const token = t.base_address || t.token_address || t.mint;
    return token === mint;
  });

  const smartMoneyBuys = smartMoneyTrades.filter((t) => {
    const token = t.base_address || t.token_address || t.mint;
    const isBuy = t.side === "buy" || t.direction === "buy" || t.is_buy === true;
    return token === mint && isBuy;
  }).length;

  const smartMoneySells = smartMoneyTrades.filter((t) => {
    const token = t.base_address || t.token_address || t.mint;
    const isSell = t.side === "sell" || t.direction === "sell" || t.is_buy === false;
    return token === mint && isSell;
  }).length;

  const kolBuys = kolTrades.filter((t) => {
    const token = t.base_address || t.token_address || t.mint;
    const isBuy = t.side === "buy" || t.direction === "buy" || t.is_buy === true;
    return token === mint && isBuy;
  }).length;

  const clusterSignals = detectClusterSignals(tokenTrades);
  const clusterSignal = clusterSignals.length > 0 ? clusterSignals[0] : null;

  return {
    smartMoneyBuys,
    smartMoneySells,
    kolBuys,
    clusterSignal,
    recentTrades: tokenTrades.slice(0, 20), // limit to 20 most recent
  };
}

/**
 * Check if smart money is exiting a token.
 * Detects full-position closes by smart money wallets.
 *
 * @param {string} mint - Token mint address
 * @returns {Object} Exit signal data
 */
export async function checkGmgnExitSignal(mint) {
  if (!mint) {
    return { exitSignal: false, walletsSelling: 0, reason: "No mint provided" };
  }

  const smartMoneyTrades = await fetchSmartMoneyTrades();

  // Find sell trades for this token
  const sells = smartMoneyTrades.filter((t) => {
    const token = t.base_address || t.token_address || t.mint;
    const isSell = t.side === "sell" || t.direction === "sell" || t.is_buy === false;
    return token === mint && isSell;
  });

  if (!sells.length) {
    return { exitSignal: false, walletsSelling: 0, reason: "No smart money sells found" };
  }

  // Count distinct wallets selling
  const sellingWallets = new Set(sells.map((s) => s.maker || s.wallet || s.user_address).filter(Boolean));

  // Check for full-position closes
  const fullCloses = sells.filter(
    (s) => s.is_full_position === true || s.position_type === "full"
  );

  const exitSignal = fullCloses.length >= 1 || sellingWallets.size >= 3;
  let reason = "No exit signal";

  if (fullCloses.length >= 1 && sellingWallets.size >= 3) {
    reason = `${sellingWallets.size} wallets selling, ${fullCloses.length} full position closes`;
  } else if (fullCloses.length >= 1) {
    reason = `${fullCloses.length} full position close(s) detected`;
  } else if (sellingWallets.size >= 3) {
    reason = `${sellingWallets.size} smart money wallets selling simultaneously`;
  }

  return {
    exitSignal,
    walletsSelling: sellingWallets.size,
    reason,
  };
}

// ── Cycle Token Screener ─────────────────────────────────────

const SKIP_TOKENS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);
const SKIP_SYMBOLS = new Set(["SOL", "WSOL", "USDC", "USDT"]);

function classifyCyclePhase({ buyCount, sellCount, ratio, smHolderCount, buyUsd, sellUsd }) {
  const buyDom = ratio >= 2.0;
  const sellDom = ratio <= 0.5;
  const balanced = ratio > 0.5 && ratio < 2.0;
  const highConviction = smHolderCount >= 5;
  const lowConviction = smHolderCount <= 2;

  if (buyDom && (lowConviction || balanced) && buyUsd > sellUsd * 3) return "accumulation";
  if (buyDom && highConviction) return "early_markup";
  if (balanced && highConviction) return "late_markup";
  if (sellDom && highConviction) return "distribution";
  if (sellDom && smHolderCount >= 3) return "early_distribution";
  if (sellDom && lowConviction) return "markdown";
  if (balanced && (buyCount + sellCount) >= 5) return "consolidation";
  return "early_interest";
}

/**
 * Screen tokens by smart money cycle phase.
 * Fetches recent smart money trades, groups by token, queries SM holder counts,
 * and classifies each into a market cycle phase.
 *
 * @param {Object} opts
 * @param {number} opts.top - Number of top tokens to analyze (default 10)
 * @param {number} opts.minUsd - Min USD per trade to include (default 0)
 * @returns {Object} { tokens: [...], summary: { phase counts } }
 */
export async function screenCycleTokens({ top = 10, minUsd = 0 } = {}) {
  // Step 1: Fetch smart money trades
  const raw = await runGmgnCli("track smartmoney --chain sol --limit 200");
  const trades = raw?.list ?? (Array.isArray(raw) ? raw : []);

  if (!trades.length) {
    return { tokens: [], summary: {}, error: "No smart money trades returned" };
  }

  // Step 2: Group by token
  const byToken = {};

  for (const t of trades) {
    const mint = t.base_address;
    if (!mint || SKIP_TOKENS.has(mint)) continue;

    const symbol = t.base_token?.symbol || mint.slice(0, 6);
    if (SKIP_SYMBOLS.has(symbol?.toUpperCase())) continue;

    const usd = parseFloat(t.amount_usd || "0");
    if (usd < minUsd) continue;

    if (!byToken[mint]) {
      byToken[mint] = {
        symbol,
        buys: 0, sells: 0,
        buyUsd: 0, sellUsd: 0,
        buyWallets: new Set(),
        sellWallets: new Set(),
        newPositions: 0, closedPositions: 0,
      };
    }

    const g = byToken[mint];
    const isBuy = t.side === "buy";

    if (isBuy) {
      g.buys++;
      g.buyUsd += usd;
      g.buyWallets.add(t.maker);
      if (t.is_open_or_close === 0) g.newPositions++;
    } else {
      g.sells++;
      g.sellUsd += usd;
      g.sellWallets.add(t.maker);
      if (t.is_open_or_close === 1) g.closedPositions++;
    }
  }

  // Step 3: Rank and take top N
  const candidates = Object.entries(byToken)
    .map(([mint, g]) => {
      const ratio = g.sells > 0 ? g.buys / g.sells : g.buys > 0 ? 99 : 0;
      const allWallets = new Set([...g.buyWallets, ...g.sellWallets]);
      return {
        mint, symbol: g.symbol,
        buyCount: g.buys, sellCount: g.sells,
        buyUsd: +g.buyUsd.toFixed(2), sellUsd: +g.sellUsd.toFixed(2),
        ratio: ratio >= 99 ? 999 : +ratio.toFixed(2),
        buyWallets: g.buyWallets.size, sellWallets: g.sellWallets.size,
        totalWallets: allWallets.size,
        newPositions: g.newPositions, closedPositions: g.closedPositions,
        smHolderCount: 0, phase: "unknown",
      };
    })
    .sort((a, b) => b.totalWallets - a.totalWallets || b.buyUsd - a.buyUsd)
    .slice(0, top);

  if (!candidates.length) {
    return { tokens: [], summary: {} };
  }

  // Step 4: Query SM holder count for each (rate-limited)
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const holdersData = await runGmgnCli(
      `token holders --chain sol --address ${c.mint} --tag smart_degen --limit 20`
    );
    c.smHolderCount = (holdersData?.list ?? []).length;
    c.phase = classifyCyclePhase(c);

    // Rate limit pause (weight=5, capacity=20 → ~1.5s between calls)
    if (i < candidates.length - 1) {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  // Step 5: Sort by phase score (best entry first)
  const phaseScore = {
    accumulation: 5, early_markup: 4, early_interest: 3,
    consolidation: 2, late_markup: 1,
    early_distribution: -1, distribution: -2, markdown: -3,
    unknown: 0,
  };
  candidates.sort((a, b) => (phaseScore[b.phase] || 0) - (phaseScore[a.phase] || 0));

  // Summary
  const summary = {};
  for (const t of candidates) {
    summary[t.phase] = (summary[t.phase] || 0) + 1;
  }

  return { tokens: candidates, summary };
}
