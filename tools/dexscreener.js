/**
 * DexScreener API client — reusable module for Meridian.
 *
 * Free API, no auth required. Rate limits:
 *   - Pair/token endpoints: 300 req/min
 *   - Trending/boosts: 60 req/min
 *
 * Features:
 *   - Retry with exponential backoff on 429
 *   - Batch token lookups (up to 30 mints per call)
 *   - Pair data cache (5min TTL)
 *   - Rate limit counter with auto-throttle
 *   - Graceful degradation (returns stale cache on 429)
 *
 * All functions return null/[] on error (never throw).
 */

const DS_BASE = "https://api.dexscreener.com";

// ── Rate Limiter ──────────────────────────────────────────────

const _rateLimits = {
  pair:    { count: 0, windowStart: Date.now(), limit: 280 }, // stay under 300
  trending: { count: 0, windowStart: Date.now(), limit: 55 },  // stay under 60
};

function trackRequest(type) {
  const rl = _rateLimits[type];
  if (!rl) return;
  const now = Date.now();
  // Reset window every 60s
  if (now - rl.windowStart > 60_000) {
    rl.count = 0;
    rl.windowStart = now;
  }
  rl.count++;
}

function isThrottled(type) {
  const rl = _rateLimits[type];
  if (!rl) return false;
  const now = Date.now();
  if (now - rl.windowStart > 60_000) {
    rl.count = 0;
    rl.windowStart = now;
  }
  return rl.count >= rl.limit;
}

export function getRateLimitStatus() {
  const now = Date.now();
  const result = {};
  for (const [type, rl] of Object.entries(_rateLimits)) {
    if (now - rl.windowStart > 60_000) {
      rl.count = 0;
      rl.windowStart = now;
    }
    result[type] = { used: rl.count, limit: rl.limit, remaining: rl.limit - rl.count };
  }
  return result;
}

/**
 * Clear all caches. Exported for testing only.
 */
export function clearDexScreenerCaches() {
  _pairCache.clear();
  _trendingCache = null;
  _trendingCacheTs = 0;
  _boostsCache = null;
  _boostsCacheTs = 0;
}

// ── Retry Fetch ───────────────────────────────────────────────

async function dsFetch(url, { rateLimitType = "pair", retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    // Auto-throttle if near limit
    if (isThrottled(rateLimitType)) {
      const waitMs = 2000 + Math.random() * 1000;
      await new Promise((r) => setTimeout(r, waitMs));
    }

    trackRequest(rateLimitType);

    try {
      const res = await fetch(url);

      if (res.status === 429) {
        // Rate limited — parse Retry-After or use exponential backoff
        const retryAfter = res.headers.get("retry-after");
        const backoffMs = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : (1000 * Math.pow(2, attempt)) + Math.random() * 500;

        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
        return { ok: false, status: 429, retried: true };
      }

      return { ok: res.ok, status: res.status, json: res.ok ? () => res.json() : null };
    } catch (err) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      return { ok: false, status: 0, error: err.message };
    }
  }
}

// ── Pair Cache ────────────────────────────────────────────────

const _pairCache = new Map(); // key: pairAddress → { data, ts }
const PAIR_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCachedPair(key) {
  const entry = _pairCache.get(key);
  if (entry && (Date.now() - entry.ts) < PAIR_CACHE_TTL) return entry.data;
  _pairCache.delete(key);
  return null;
}

function setCachedPair(key, data) {
  _pairCache.set(key, { data, ts: Date.now() });
  // Evict stale entries if cache grows large
  if (_pairCache.size > 200) {
    const cutoff = Date.now() - PAIR_CACHE_TTL;
    for (const [k, v] of _pairCache) {
      if (v.ts < cutoff) _pairCache.delete(k);
    }
  }
}

// ── Pair Data (single) ───────────────────────────────────────

/**
 * Fetch DexScreener pair data for a Solana pool address.
 * Returns the first matching pair or null. Cached 5min.
 */
export async function getDexScreenerPair({ pairAddress }) {
  if (!pairAddress) return null;

  const cached = getCachedPair(`pair:${pairAddress}`);
  if (cached !== null) return cached;

  const res = await dsFetch(`${DS_BASE}/latest/dex/pairs/solana/${pairAddress}`);
  if (!res.ok) {
    // On 429, return stale cache if available
    return getCachedPair(`pair:${pairAddress}`);
  }
  const data = await res.json();
  const pairs = data.pairs || [];
  const result = pairs.find((p) => p.chainId === "solana") || pairs[0] || null;
  if (result) setCachedPair(`pair:${pairAddress}`, result);
  return result;
}

// ── Batch Token Lookup ────────────────────────────────────────

/**
 * Fetch DexScreener data for multiple token mints in a SINGLE API call.
 * Uses /tokens/v1/solana/{comma-separated} endpoint (up to 30 mints).
 *
 * Returns Map<string, pair[]> — mint → array of Solana pairs sorted by volume.
 *
 * This is the KEY optimization: 10 candidates = 1 API call instead of 10.
 */
export async function getDexScreenerBatch({ mints }) {
  if (!mints?.length) return new Map();

  // Filter out mints we already have cached
  const uncached = [];
  const results = new Map();

  for (const mint of mints) {
    const cached = getCachedPair(`mint:${mint}`);
    if (cached !== null) {
      results.set(mint, cached);
    } else {
      uncached.push(mint);
    }
  }

  if (!uncached.length) return results;

  // Batch in chunks of 30 (API limit)
  const BATCH_SIZE = 30;
  for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
    const chunk = uncached.slice(i, i + BATCH_SIZE);
    const url = `${DS_BASE}/tokens/v1/solana/${chunk.join(",")}`;

    const res = await dsFetch(url, { rateLimitType: "pair" });
    if (!res.ok) {
      // On 429, try to serve from stale cache
      for (const mint of chunk) {
        const stale = getCachedPair(`mint:${mint}`);
        if (stale !== null) results.set(mint, stale);
      }
      continue;
    }

    const pairs = await res.json();
    if (!Array.isArray(pairs)) continue;

    // Group by base token mint
    const grouped = new Map();
    for (const pair of pairs) {
      if (pair.chainId !== "solana") continue;
      const mint = pair.baseToken?.address;
      if (!mint) continue;
      if (!grouped.has(mint)) grouped.set(mint, []);
      grouped.get(mint).push(pair);
    }

    // Sort each group by 24h volume and cache
    for (const mint of chunk) {
      const mintPairs = grouped.get(mint) || [];
      mintPairs.sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
      results.set(mint, mintPairs);
      setCachedPair(`mint:${mint}`, mintPairs);
    }

    // Brief pause between batches if chunked
    if (i + BATCH_SIZE < uncached.length) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  return results;
}

/**
 * Convenience: get best pair for a single mint from batch lookup.
 * Returns the highest-volume Solana pair or null.
 */
export async function getDexScreenerPairByMint({ mint }) {
  if (!mint) return null;
  const batch = await getDexScreenerBatch({ mints: [mint] });
  const pairs = batch.get(mint) || [];
  return pairs[0] || null;
}

// ── Legacy single-mint endpoint (kept for scripts) ────────────

/**
 * Fetch DexScreener pair data for a token mint (single, not batched).
 * Returns array of Solana pairs sorted by 24h volume descending.
 */
export async function getDexScreenerTokenPairs({ mint }) {
  if (!mint) return [];
  const res = await dsFetch(`${DS_BASE}/token-pairs/v1/solana/${mint}`, { rateLimitType: "pair" });
  if (!res.ok) return [];
  const pairs = await res.json();
  const sol = Array.isArray(pairs) ? pairs.filter((p) => p.chainId === "solana") : [];
  sol.sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
  return sol;
}

// ── Extract Metrics ───────────────────────────────────────────

/**
 * Extract key enrichment data from a DexScreener pair object.
 * Returns a flat object suitable for adding to candidate blocks.
 */
export function extractPairMetrics(pair) {
  if (!pair) return null;

  const txns1h = pair.txns?.h1 || {};
  const buys1h = txns1h.buys || 0;
  const sells1h = txns1h.sells || 0;
  const total1h = buys1h + sells1h;

  return {
    // Buy/sell ratios
    ds_buys_1h: buys1h,
    ds_sells_1h: sells1h,
    ds_buy_ratio_1h: total1h > 0 && sells1h > 0 ? parseFloat((buys1h / sells1h).toFixed(2)) : null,
    ds_buy_pct_1h: total1h > 0 ? parseFloat(((buys1h / total1h) * 100).toFixed(0)) : null,

    // Multi-timeframe price changes (already percentages from API)
    ds_price_change_5m: pair.priceChange?.m5 ?? null,
    ds_price_change_1h: pair.priceChange?.h1 ?? null,
    ds_price_change_6h: pair.priceChange?.h6 ?? null,
    ds_price_change_24h: pair.priceChange?.h24 ?? null,

    // Volume by timeframe
    ds_volume_1h: pair.volume?.h1 ?? null,
    ds_volume_6h: pair.volume?.h6 ?? null,
    ds_volume_24h: pair.volume?.h24 ?? null,

    // Liquidity
    ds_liquidity_usd: pair.liquidity?.usd ?? null,

    // Boosts
    ds_boosts_active: pair.boosts?.active ?? 0,

    // Pair info
    ds_dex: pair.dexId ?? null,
    ds_pair_address: pair.pairAddress ?? null,
  };
}

// ── Trending Narratives ───────────────────────────────────────

let _trendingCache = null;
let _trendingCacheTs = 0;
const TRENDING_CACHE_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Fetch trending narratives from DexScreener.
 * Cached 15 minutes. Returns stale cache on 429.
 */
export async function getDexScreenerTrending() {
  const now = Date.now();
  if (_trendingCache && (now - _trendingCacheTs) < TRENDING_CACHE_MS) {
    return _trendingCache;
  }
  const res = await dsFetch(`${DS_BASE}/metas/trending/v1`, { rateLimitType: "trending" });
  if (!res.ok) return _trendingCache || [];
  const data = await res.json();
  _trendingCache = data;
  _trendingCacheTs = now;
  return data;
}

/**
 * Format trending narratives into a compact prompt-ready string.
 * Example: "AI (+3.2% 24h), MEMES (-1.1% 24h), DEFI (+0.5% 24h)"
 */
export async function formatTrendingForPrompt() {
  const trending = await getDexScreenerTrending();
  if (!trending.length) return null;

  // Sort by 24h volume
  const sorted = [...trending].sort((a, b) => (b.volume || 0) - (a.volume || 0));
  const top = sorted.slice(0, 8);

  return top.map((m) => {
    const h24 = m.marketCapChange?.h24;
    const chg = h24 != null ? `${h24 >= 0 ? "+" : ""}${h24.toFixed(1)}%` : "?";
    return `${m.name} (${chg} 24h, $${fmtCompact(m.marketCap)} mcap, ${m.tokenCount} tokens)`;
  }).join(", ");
}

// ── Boosts ────────────────────────────────────────────────────

let _boostsCache = null;
let _boostsCacheTs = 0;
const BOOSTS_CACHE_MS = 15 * 60 * 1000;

/**
 * Fetch top boosted Solana tokens from DexScreener.
 * Cached 15 minutes.
 */
export async function getDexScreenerBoosts() {
  const now = Date.now();
  if (_boostsCache && (now - _boostsCacheTs) < BOOSTS_CACHE_MS) {
    return _boostsCache;
  }
  const res = await dsFetch(`${DS_BASE}/token-boosts/top/v1`, { rateLimitType: "trending" });
  if (!res.ok) return _boostsCache || [];
  const data = await res.json();
  const sol = data.filter((d) => d.chainId === "solana");
  _boostsCache = sol;
  _boostsCacheTs = now;
  return sol;
}

// ── Helpers ───────────────────────────────────────────────────

function fmtCompact(n) {
  if (n == null) return "?";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return `${n.toFixed(0)}`;
}
