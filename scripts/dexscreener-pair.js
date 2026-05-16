#!/usr/bin/env node

/**
 * DexScreener Pair Enrichment — fetch data for a Solana pool or token.
 *
 * Usage:
 *   node scripts/dexscreener-pair.js --pool <pairAddress>
 *   node scripts/dexscreener-pair.js --mint <tokenMint>
 *   node scripts/dexscreener-pair.js --mint <addr> --json
 */

const DS_BASE = "https://api.dexscreener.com";

// ── CLI args ──────────────────────────────────────────────────

function parseArgs() {
  const a = process.argv.slice(2);
  const p = { pool: null, mint: null, json: false, limit: 5 };
  for (let i = 0; i < a.length; i++) {
    switch (a[i]) {
      case "--pool":   p.pool = a[++i]; break;
      case "--mint":   p.mint = a[++i]; break;
      case "--limit":  p.limit = parseInt(a[++i], 10) || 5; break;
      case "--json":   p.json = true; break;
      case "--help":
        console.log(`
Usage: node scripts/dexscreener-pair.js [options]

Options:
  --pool <address>   Solana pair address (DLMM pool or AMM pair)
  --mint <address>   Token mint address (shows all pairs for that token)
  --limit <n>        Max pairs to show for mint queries (default: 5, sorted by volume)
  --json             Output raw JSON instead of formatted text
  --help             Show this help

Examples:
  node scripts/dexscreener-pair.js --pool JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN
  node scripts/dexscreener-pair.js --mint DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
  node scripts/dexscreener-pair.js --mint <addr> --limit 3 --json
`);
        process.exit(0);
    }
  }
  return p;
}

// ── API ───────────────────────────────────────────────────────

async function fetchPairsByPool(pairAddress) {
  const url = `${DS_BASE}/latest/dex/pairs/solana/${pairAddress}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DexScreener pair error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.pairs || [];
}

async function fetchPairsByMint(mint) {
  const url = `${DS_BASE}/token-pairs/v1/solana/${mint}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DexScreener token-pairs error: ${res.status} ${res.statusText}`);
  return await res.json(); // returns array directly
}

// ── Formatting ────────────────────────────────────────────────

function fmtUsd(n) {
  if (n == null) return "—";
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

function fmtPct(n) {
  if (n == null) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function fmtPrice(n) {
  if (n == null) return "—";
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  if (n >= 0.0001) return `$${n.toFixed(6)}`;
  return `$${n.toExponential(2)}`;
}

function ageFromMs(ms) {
  if (!ms) return "—";
  const now = Date.now();
  const diff = now - ms;
  if (diff < 0) return "just created";
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(mins / 60);
  const days = Math.floor(hrs / 24);
  if (days > 0) return `${days}d ${hrs % 24}h`;
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  return `${mins}m`;
}

function formatPair(pair) {
  const base = pair.baseToken || {};
  const quote = pair.quoteToken || {};
  const liq = pair.liquidity || {};
  const vol = pair.volume || {};
  const chg = pair.priceChange || {};
  const txns = pair.txns || {};
  const info = pair.info || {};
  const boosts = pair.boosts || {};

  const name = `${base.symbol || "?"}/${quote.symbol || "?"}`;
  const lines = [];

  lines.push(`DexScreener: ${name} (${pair.dexId || "?"})`);
  lines.push("═".repeat(40));
  lines.push("");

  // Price
  const price = parseFloat(pair.priceUsd);
  const priceNative = parseFloat(pair.priceNative);
  const parts = [];
  parts.push(fmtPrice(price));
  if (chg.h1 != null) parts.push(`${fmtPct(chg.h1)} 1h`);
  if (chg.h6 != null) parts.push(`${fmtPct(chg.h6)} 6h`);
  if (chg.h24 != null) parts.push(`${fmtPct(chg.h24)} 24h`);
  lines.push(`Price:     ${parts.join(" | ")}`);
  if (priceNative) lines.push(`Price SOL: ${priceNative} SOL`);

  // Volume
  const volParts = [];
  if (vol.h1) volParts.push(`${fmtUsd(vol.h1)} 1h`);
  if (vol.h6) volParts.push(`${fmtUsd(vol.h6)} 6h`);
  if (vol.h24) volParts.push(`${fmtUsd(vol.h24)} 24h`);
  if (vol.m5) volParts.push(`${fmtUsd(vol.m5)} 5m`);
  if (volParts.length) lines.push(`Volume:    ${volParts.join(" | ")}`);

  // Txns (buy/sell)
  const t1h = txns.h1 || {};
  const t6h = txns.h6 || {};
  const t24h = txns.h24 || {};
  const buys1h = t1h.buys || 0;
  const sells1h = t1h.sells || 0;
  const ratio1h = sells1h > 0 ? (buys1h / sells1h).toFixed(2) : "∞";
  const buyPct1h = (buys1h + sells1h) > 0 ? ((buys1h / (buys1h + sells1h)) * 100).toFixed(0) : "?";

  if (buys1h || sells1h) {
    lines.push(`Txns 1h:   ${buys1h} buys / ${sells1h} sells — ratio ${ratio1h} (${buyPct1h}% buys)`);
  }
  if (t6h.buys || t6h.sells) {
    const buys6h = t6h.buys || 0;
    const sells6h = t6h.sells || 0;
    const ratio6h = sells6h > 0 ? (buys6h / sells6h).toFixed(2) : "∞";
    lines.push(`Txns 6h:   ${buys6h} buys / ${sells6h} sells — ratio ${ratio6h}`);
  }
  if (t24h.buys || t24h.sells) {
    const buys24h = t24h.buys || 0;
    const sells24h = t24h.sells || 0;
    const ratio24h = sells24h > 0 ? (buys24h / sells24h).toFixed(2) : "∞";
    lines.push(`Txns 24h:  ${buys24h} buys / ${sells24h} sells — ratio ${ratio24h}`);
  }

  // Liquidity
  if (liq.usd) {
    const liqParts = [fmtUsd(liq.usd)];
    if (liq.quote) liqParts.push(`quote: ${fmtUsd(liq.quote)} ${quote.symbol || "SOL"}`);
    lines.push(`Liquidity: ${liqParts.join(", ")}`);
  }

  // FDV / MCap
  const fdvMcap = [];
  if (pair.fdv) fdvMcap.push(`FDV: ${fmtUsd(pair.fdv)}`);
  if (pair.marketCap) fdvMcap.push(`MCap: ${fmtUsd(pair.marketCap)}`);
  if (fdvMcap.length) lines.push(fdvMcap.join(" | "));

  // Boosts
  if (boosts.active != null && boosts.active > 0) {
    lines.push(`Boosts:    ${boosts.active} active`);
  }

  // Created
  if (pair.pairCreatedAt) {
    const age = ageFromMs(pair.pairCreatedAt);
    const date = new Date(pair.pairCreatedAt).toISOString().slice(0, 10);
    lines.push(`Created:   ${date} (${age} ago)`);
  }

  // Labels
  if (pair.labels && pair.labels.length) {
    lines.push(`Labels:    ${pair.labels.join(", ")}`);
  }

  // Socials
  const socials = info.socials || [];
  const websites = info.websites || [];
  if (socials.length || websites.length) {
    lines.push("");
    const socialStrs = socials.map((s) => {
      const raw = s.url || s.handle || "";
      let display = raw;
      // Strip known domains to show handles
      display = display.replace(/^https?:\/\/(twitter\.com|x\.com)\//, "@");
      display = display.replace(/^https?:\/\/t\.me\//, "t.me/");
      display = display.replace(/^https?:\/\/(www\.)?discord\.(gg|com)\//, "discord.gg/");
      return `${s.type || "?"} ${display}`;
    });
    const webStrs = websites.map((w) => w.url);
    lines.push(`Socials:   ${socialStrs.join(", ") || "—"}`);
    lines.push(`Website:   ${webStrs.join(", ") || "—"}`);
  }

  // Pair address
  lines.push("");
  lines.push(`Pair:      ${pair.pairAddress || "—"}`);
  lines.push(`URL:       ${pair.url || "—"}`);

  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  if (!args.pool && !args.mint) {
    console.error("Error: provide --pool or --mint. Use --help for usage.");
    process.exit(1);
  }

  let pairs;
  try {
    if (args.pool) {
      pairs = await fetchPairsByPool(args.pool);
    } else {
      pairs = await fetchPairsByMint(args.mint);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  if (!pairs || !pairs.length) {
    console.log("No pairs found for this address.");
    process.exit(0);
  }

  // Filter to Solana only (token-pairs endpoint may return cross-chain)
  const solPairs = pairs.filter((p) => p.chainId === "solana");
  if (!solPairs.length) {
    console.log(`Found ${pairs.length} pair(s) but none on Solana.`);
    process.exit(0);
  }

  // Sort by 24h volume descending, then apply limit
  solPairs.sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
  const limited = args.pool ? solPairs : solPairs.slice(0, args.limit);

  if (args.json) {
    console.log(JSON.stringify(limited.length === 1 ? limited[0] : limited, null, 2));
    return;
  }

  // Format each pair
  for (let i = 0; i < limited.length; i++) {
    if (i > 0) console.log("\n");
    console.log(formatPair(limited[i]));
  }
}

main();
