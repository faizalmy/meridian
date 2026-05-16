#!/usr/bin/env node

/**
 * DexScreener Trending Narratives — show hot themes and narratives.
 *
 * Usage:
 *   node scripts/dexscreener-trending.js              # list trending narratives
 *   node scripts/dexscreener-trending.js --slug ai    # detail + top pairs for a narrative
 *   node scripts/dexscreener-trending.js --json       # raw JSON output
 */

const DS_BASE = "https://api.dexscreener.com";

// ── CLI args ──────────────────────────────────────────────────

function parseArgs() {
  const a = process.argv.slice(2);
  const p = { slug: null, json: false, limit: 15 };
  for (let i = 0; i < a.length; i++) {
    switch (a[i]) {
      case "--slug":   p.slug = a[++i]; break;
      case "--limit":  p.limit = parseInt(a[++i], 10) || 15; break;
      case "--json":   p.json = true; break;
      case "--help":
        console.log(`
Usage: node scripts/dexscreener-trending.js [options]

Options:
  --slug <name>   Show detail + top pairs for a specific narrative (e.g. "ai", "memes")
  --limit <n>     Max narratives to show (default: 15)
  --json          Output raw JSON
  --help          Show this help

Examples:
  node scripts/dexscreener-trending.js
  node scripts/dexscreener-trending.js --slug ai
  node scripts/dexscreener-trending.js --json
`);
        process.exit(0);
    }
  }
  return p;
}

// ── API ───────────────────────────────────────────────────────

async function fetchTrending() {
  const res = await fetch(`${DS_BASE}/metas/trending/v1`);
  if (!res.ok) throw new Error(`Trending API error: ${res.status}`);
  return await res.json();
}

async function fetchMetaDetail(slug) {
  const res = await fetch(`${DS_BASE}/metas/meta/v1/${slug}`);
  if (!res.ok) throw new Error(`Meta API error: ${res.status}`);
  return await res.json();
}

// ── Formatting ────────────────────────────────────────────────

function fmtUsd(n) {
  if (n == null) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  return `$${n.toFixed(0)}`;
}

function fmtPct(n) {
  if (n == null) return "—";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function formatTrendingList(data, limit) {
  const lines = [];
  lines.push("Trending Narratives (DexScreener)");
  lines.push("═".repeat(40));
  lines.push("");

  // Sort by 24h volume descending
  const sorted = [...data].sort((a, b) => (b.volume || 0) - (a.volume || 0));
  const shown = sorted.slice(0, limit);

  for (const m of shown) {
    const emoji = m.icon?.type === "emoji" ? m.icon.value : "";
    const h24 = m.marketCapChange?.h24;
    const vol = m.volume || 0;
    const mcap = m.marketCap || 0;
    const tokens = m.tokenCount || 0;

    const pad = (s, n) => String(s).padEnd(n);
    const padL = (s, n) => String(s).padStart(n);

    lines.push(
      `  ${pad(emoji + " " + m.name, 25)} ${padL(fmtUsd(mcap), 8)} mcap  ${padL(fmtPct(h24), 8)} 24h  ${padL(tokens + " tokens", 12)}`
    );
  }

  lines.push("");
  lines.push(`Use --slug <name> for top pairs in that narrative.`);
  return lines.join("\n");
}

function formatMetaDetail(data) {
  const lines = [];
  const emoji = data.icon?.type === "emoji" ? data.icon.value : "";
  lines.push(`${emoji} ${data.name} Narrative`);
  lines.push("═".repeat(40));
  lines.push(data.description || "");
  lines.push("");

  lines.push(`Market Cap: ${fmtUsd(data.marketCap)}`);
  lines.push(`Liquidity:  ${fmtUsd(data.liquidity)}`);
  lines.push(`Volume:     ${fmtUsd(data.volume)}`);
  lines.push(`Tokens:     ${data.tokenCount}`);
  lines.push("");

  // Market cap changes
  const mc = data.marketCapChange || {};
  lines.push("MCap Change:");
  if (mc.m5 != null) lines.push(`  5m:   ${fmtPct(mc.m5)}`);
  if (mc.h1 != null) lines.push(`  1h:   ${fmtPct(mc.h1)}`);
  if (mc.h6 != null) lines.push(`  6h:   ${fmtPct(mc.h6)}`);
  if (mc.h24 != null) lines.push(`  24h:  ${fmtPct(mc.h24)}`);
  lines.push("");

  // Top pairs
  const pairs = data.pairs || [];
  if (pairs.length) {
    lines.push(`Top Pairs (${pairs.length} total):`);
    lines.push("  " + "-".repeat(55));
    // Sort by 24h volume
    const sorted = [...pairs].sort((a, b) => (b.volume?.h24 || 0) - (a.volume?.h24 || 0));
    for (const p of sorted.slice(0, 10)) {
      const base = p.baseToken?.symbol || "?";
      const quote = p.quoteToken?.symbol || "?";
      const vol24 = p.volume?.h24 || 0;
      const liq = p.liquidity?.usd || 0;
      const chg = p.priceChange?.h24;
      const price = parseFloat(p.priceUsd) || 0;

      lines.push(
        `  ${base}/${quote} (${p.dexId})  ` +
        `vol ${fmtUsd(vol24)}  liq ${fmtUsd(liq)}  ` +
        `price $${price < 0.01 ? price.toExponential(1) : price.toFixed(4)}  ` +
        `24h ${fmtPct(chg)}`
      );
    }
  }

  return lines.join("\n");
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  try {
    if (args.slug) {
      const data = await fetchMetaDetail(args.slug);
      if (args.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(formatMetaDetail(data));
      }
    } else {
      const data = await fetchTrending();
      if (args.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(formatTrendingList(data, args.limit));
      }
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
