#!/usr/bin/env node

/**
 * DexScreener Top Boosted Tokens — show which Solana tokens are getting the most ad spend.
 *
 * Usage:
 *   node scripts/dexscreener-boosts.js                # top 20
 *   node scripts/dexscreener-boosts.js --limit 10     # top 10
 *   node scripts/dexscreener-boosts.js --enrich       # enrich with volume/price data
 *   node scripts/dexscreener-boosts.js --json         # raw JSON
 */

const DS_BASE = "https://api.dexscreener.com";

// ── CLI args ──────────────────────────────────────────────────

function parseArgs() {
  const a = process.argv.slice(2);
  const p = { limit: 20, enrich: false, json: false };
  for (let i = 0; i < a.length; i++) {
    switch (a[i]) {
      case "--limit":   p.limit = parseInt(a[++i], 10) || 20; break;
      case "--enrich":  p.enrich = true; break;
      case "--json":    p.json = true; break;
      case "--help":
        console.log(`
Usage: node scripts/dexscreener-boosts.js [options]

Options:
  --limit <n>     Max tokens to show (default: 20)
  --enrich        Fetch volume/price for each token (slower, ~30 extra API calls)
  --json          Output raw JSON
  --help          Show this help

Examples:
  node scripts/dexscreener-boosts.js
  node scripts/dexscreener-boosts.js --limit 5 --enrich
`);
        process.exit(0);
    }
  }
  return p;
}

// ── API ───────────────────────────────────────────────────────

async function fetchTopBoosts() {
  const res = await fetch(`${DS_BASE}/token-boosts/top/v1`);
  if (!res.ok) throw new Error(`Boosts API error: ${res.status}`);
  const data = await res.json();
  return data.filter((d) => d.chainId === "solana");
}

async function fetchTokenPairData(mint) {
  try {
    const res = await fetch(`${DS_BASE}/tokens/v1/solana/${mint}`);
    if (!res.ok) return null;
    const pairs = await res.json();
    if (!Array.isArray(pairs) || !pairs.length) return null;
    // Find highest-volume SOL pair
    const solPairs = pairs.filter((p) => p.quoteToken?.symbol === "SOL");
    const best = solPairs.length ? solPairs : pairs;
    best.sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
    return best[0] || null;
  } catch {
    return null;
  }
}

// ── Formatting ────────────────────────────────────────────────

function fmtUsd(n) {
  if (n == null) return "—";
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtPct(n) {
  if (n == null) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function trunc(s, max) {
  if (!s) return "—";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

async function main() {
  const args = parseArgs();

  let boosts;
  try {
    boosts = await fetchTopBoosts();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  if (!boosts.length) {
    console.log("No boosted tokens found.");
    process.exit(0);
  }

  const shown = boosts.slice(0, args.limit);

  if (args.json) {
    if (args.enrich) {
      // Enrich each with pair data
      const enriched = [];
      for (const b of shown) {
        const pair = await fetchTokenPairData(b.tokenAddress);
        enriched.push({
          ...b,
          pair: pair ? {
            pairAddress: pair.pairAddress,
            dexId: pair.dexId,
            priceUsd: pair.priceUsd,
            volume24h: pair.volume?.h24 || null,
            liquidityUsd: pair.liquidity?.usd || null,
            priceChange24h: pair.priceChange?.h24 || null,
          } : null,
        });
        // Brief delay to respect rate limits
        await new Promise((r) => setTimeout(r, 200));
      }
      console.log(JSON.stringify(enriched, null, 2));
    } else {
      console.log(JSON.stringify(shown, null, 2));
    }
    return;
  }

  // Human-readable output
  const lines = [];
  lines.push("Top Boosted Tokens (Solana) — DexScreener");
  lines.push("═".repeat(45));
  lines.push("");

  if (args.enrich) {
    lines.push("  #  Token                    Boost   Vol 24h     Liq        Price      24h Chg  Dex");
    lines.push("  " + "─".repeat(90));

    for (let i = 0; i < shown.length; i++) {
      const b = shown[i];
      const pair = await fetchTokenPairData(b.tokenAddress);
      const price = pair ? parseFloat(pair.priceUsd) : null;
      const vol = pair?.volume?.h24;
      const liq = pair?.liquidity?.usd;
      const chg = pair?.priceChange?.h24;
      const dex = pair?.dexId || "—";
      const priceStr = price != null
        ? (price < 0.01 ? price.toExponential(1) : `$${price.toFixed(4)}`)
        : "—";

      const num = String(i + 1).padStart(2);
      const name = trunc(b.description || b.tokenAddress.slice(0, 8), 22).padEnd(22);
      const boost = String(b.totalAmount).padStart(5);
      const volStr = fmtUsd(vol).padStart(10);
      const liqStr = fmtUsd(liq).padStart(10);
      const priceS = priceStr.padStart(10);
      const chgStr = fmtPct(chg).padStart(8);
      const dexS = dex.padEnd(10);

      lines.push(`  ${num}  ${name} ${boost}   ${volStr}   ${liqStr}   ${priceS}  ${chgStr}  ${dexS}`);
    }
  } else {
    lines.push("  #  Boost   Token                                          Address");
    lines.push("  " + "─".repeat(85));

    for (let i = 0; i < shown.length; i++) {
      const b = shown[i];
      const num = String(i + 1).padStart(2);
      const boost = String(b.totalAmount).padStart(5);
      const name = trunc(b.description || "?", 44).padEnd(44);
      const addr = b.tokenAddress?.slice(0, 16) + "…";
      lines.push(`  ${num}  ${boost}   ${name} ${addr}`);
    }
  }

  lines.push("");
  lines.push(`Use --enrich to add volume/price data (slower).`);

  console.log(lines.join("\n"));
}

main();
