#!/usr/bin/env node

/**
 * Cycle Token Screener — identifies tokens in different market cycle phases
 * based on smart money activity from GMGN.
 *
 * Workflow:
 *   1. Fetch recent smart money trades (track smartmoney)
 *   2. Group by token → buy/sell ratio, volume, wallet counts
 *   3. For top tokens → query token holders (smart_degen tag)
 *   4. Classify cycle phase: Accumulation / Markup / Distribution / Markdown
 *   5. Output ranked table
 *
 * Usage:
 *   node scripts/gmgn-cycle-screener.js              # default: top 15 tokens
 *   node scripts/gmgn-cycle-screener.js --top 20     # top 20 tokens
 *   node scripts/gmgn-cycle-screener.js --raw        # JSON output
 *   node scripts/gmgn-cycle-screener.js --min-usd 1000  # min trade USD
 */

import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// ── CLI Args ───────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { top: 15, raw: false, minUsd: 0, limit: 200 };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--top":    opts.top = +args[++i] || 15; break;
      case "--raw":    opts.raw = true; break;
      case "--min-usd": opts.minUsd = +args[++i] || 0; break;
      case "--limit":  opts.limit = +args[++i] || 200; break;
      case "--help":
        console.log(`
Usage: node scripts/gmgn-cycle-screener.js [options]

Options:
  --top <n>       Number of top tokens to analyze (default: 15)
  --limit <n>     Smart money trades to fetch (default: 200, max: 200)
  --min-usd <n>   Min USD per trade to include (default: 0)
  --raw           Output raw JSON instead of table
  --help          Show this help
`);
        process.exit(0);
    }
  }
  return opts;
}

// ── GMGN CLI Runner ────────────────────────────────────────────

async function runGmgn(args) {
  try {
    const { stdout } = await execAsync(`gmgn-cli ${args} --raw`, {
      timeout: 30_000,
      encoding: "utf8",
    });
    const trimmed = stdout.trim();
    const jsonStart = trimmed.search(/[\[{]/);
    if (jsonStart === -1) return null;
    return JSON.parse(trimmed.slice(jsonStart));
  } catch (err) {
    console.error(`  [ERROR] gmgn-cli ${args.split(" ")[0]}: ${err.message?.slice(0, 80)}`);
    return null;
  }
}

// ── Rate Limit: pause between heavy calls ──────────────────────

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Phase Detection ────────────────────────────────────────────

function classifyPhase({ buyCount, sellCount, ratio, smHolderCount, avgHoldPct, buyUsd, sellUsd }) {
  const totalTrades = buyCount + sellCount;
  if (totalTrades === 0) return "Unknown";

  const buyDom = ratio >= 2.0;        // buys 2x+ sells
  const sellDom = ratio <= 0.5;       // sells 2x+ buys
  const balanced = ratio > 0.5 && ratio < 2.0;

  const highConviction = smHolderCount >= 5;
  const lowConviction = smHolderCount <= 2;

  // Accumulation: smart money buying heavily, few holders (early entry)
  if (buyDom && (lowConviction || balanced) && buyUsd > sellUsd * 3) {
    return "Accumulation";
  }

  // Early Markup: buying continues, holders growing
  if (buyDom && highConviction) {
    return "Early Markup";
  }

  // Late Markup: balanced but many holders sitting on gains
  if (balanced && highConviction && avgHoldPct > 1) {
    return "Late Markup";
  }

  // Distribution: smart money selling, many holders (exiting)
  if (sellDom && highConviction) {
    return "Distribution";
  }

  // Early Distribution: selling picking up, still has holders
  if (sellDom && smHolderCount >= 3) {
    return "Early Distribution";
  }

  // Markdown: selling heavily, few holders left
  if (sellDom && lowConviction) {
    return "Markdown";
  }

  // Neutral with activity
  if (balanced && totalTrades >= 5) {
    return "Consolidation";
  }

  return "Early Interest";
}

function phaseEmoji(phase) {
  const map = {
    "Accumulation":       "🟢",
    "Early Markup":       "🚀",
    "Late Markup":        "🟡",
    "Distribution":       "🔴",
    "Early Distribution": "🟠",
    "Markdown":           "⚫",
    "Consolidation":      "⚪",
    "Early Interest":     "🔵",
    "Unknown":            "❓",
  };
  return map[phase] || "❓";
}

function phaseScore(phase) {
  // Higher = more actionable for entry
  const map = {
    "Accumulation":       5,
    "Early Markup":       4,
    "Early Interest":     3,
    "Consolidation":      2,
    "Late Markup":        1,
    "Early Distribution": -1,
    "Distribution":       -2,
    "Markdown":           -3,
    "Unknown":            0,
  };
  return map[phase] || 0;
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  console.log(`\n🔍 Cycle Token Screener (GMGN Smart Money)\n`);
  console.log(`  Fetching ${opts.limit} recent smart money trades...`);

  // Step 1: Fetch smart money trades
  const raw = await runGmgn(`track smartmoney --chain sol --limit ${opts.limit}`);
  const trades = raw?.list ?? (Array.isArray(raw) ? raw : []);

  if (!trades.length) {
    console.error("  No trades returned. Check gmgn-cli config.");
    process.exit(1);
  }

  console.log(`  Got ${trades.length} trades\n`);

  // Step 2: Group by token
  const byToken = {};

  // Filter out stablecoins and wrapped natives
  const SKIP_SYMBOLS = new Set(["SOL", "WSOL", "USDC", "USDT", "BONK", "WETH"]);
  const SKIP_MINTS = new Set([
    "So11111111111111111111111111111111111111112",  // SOL
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
    "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
  ]);

  for (const t of trades) {
    const mint = t.base_address;
    if (!mint) continue;
    if (SKIP_MINTS.has(mint)) continue;

    const symbol = t.base_token?.symbol || mint.slice(0, 6);
    if (SKIP_SYMBOLS.has(symbol?.toUpperCase())) continue;

    const usd = parseFloat(t.amount_usd || "0");
    if (usd < opts.minUsd) continue;

    if (!byToken[mint]) {
      byToken[mint] = {
        symbol,
        buys: 0,
        sells: 0,
        buyUsd: 0,
        sellUsd: 0,
        buyWallets: new Set(),
        sellWallets: new Set(),
        newPositions: 0,
        closedPositions: 0,
      };
    }

    const g = byToken[mint];
    const isBuy = t.side === "buy";
    const maker = t.maker;

    if (isBuy) {
      g.buys++;
      g.buyUsd += usd;
      g.buyWallets.add(maker);
      // is_open_or_close: 0 = position opened for smartmoney
      if (t.is_open_or_close === 0) g.newPositions++;
    } else {
      g.sells++;
      g.sellUsd += usd;
      g.sellWallets.add(maker);
      // is_open_or_close: 1 = position closed for smartmoney
      if (t.is_open_or_close === 1) g.closedPositions++;
    }
  }

  // Step 3: Rank by smart money activity (buy wallet count + volume)
  const tokens = Object.entries(byToken)
    .map(([mint, g]) => {
      const ratio = g.sells > 0 ? g.buys / g.sells : g.buys > 0 ? 99 : 0;
      const allWallets = new Set([...g.buyWallets, ...g.sellWallets]);
      return {
        mint,
        symbol: g.symbol,
        buyCount: g.buys,
        sellCount: g.sells,
        buyUsd: g.buyUsd,
        sellUsd: g.sellUsd,
        ratio,
        buyWallets: g.buyWallets.size,
        sellWallets: g.sellWallets.size,
        totalWallets: allWallets.size,
        newPositions: g.newPositions,
        closedPositions: g.closedPositions,
        smHolderCount: 0,      // will be filled in step 4
        avgHoldPct: 0,
      };
    })
    .sort((a, b) => b.totalWallets - a.totalWallets || b.buyUsd - a.buyUsd)
    .slice(0, opts.top);

  if (!tokens.length) {
    console.log("  No tokens found after filtering.");
    process.exit(0);
  }

  // Step 4: Query token holders for smart money count
  console.log(`  Analyzing top ${tokens.length} tokens for smart money holders...\n`);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    process.stdout.write(`  [${i + 1}/${tokens.length}] ${t.symbol}... `);

    const holdersData = await runGmgn(
      `token holders --chain sol --address ${t.mint} --tag smart_degen --limit 20`
    );

    const holders = holdersData?.list ?? [];
    t.smHolderCount = holders.length;
    t.avgHoldPct = holders.length > 0
      ? holders.reduce((sum, h) => sum + (h.amount_percentage || 0), 0) / holders.length * 100
      : 0;

    console.log(`${t.smHolderCount} SM holders`);

    // Rate limit: ~1.5s between holder calls (weight=5, capacity=20)
    if (i < tokens.length - 1) await delay(1500);
  }

  // Step 5: Classify phases
  for (const t of tokens) {
    t.phase = classifyPhase(t);
    t.score = phaseScore(t.phase);
  }

  // Sort by score (best entry opportunities first), then by buy activity
  tokens.sort((a, b) => b.score - a.score || b.buyUsd - a.buyUsd);

  // Step 6: Output
  if (opts.raw) {
    console.log(JSON.stringify(tokens.map(t => ({
      symbol: t.symbol,
      mint: t.mint,
      phase: t.phase,
      score: t.score,
      buyCount: t.buyCount,
      sellCount: t.sellCount,
      ratio: +t.ratio.toFixed(2),
      buyUsd: +t.buyUsd.toFixed(0),
      sellUsd: +t.sellUsd.toFixed(0),
      smHolders: t.smHolderCount,
      avgHoldPct: +t.avgHoldPct.toFixed(2),
      newPositions: t.newPositions,
      closedPositions: t.closedPositions,
    })), null, 2));
    return;
  }

  // Pretty table
  console.log(`\n${"═".repeat(100)}`);
  console.log(`  CYCLE TOKEN SCREENER — Smart Money Activity (GMGN)`);
  console.log(`${"═".repeat(100)}\n`);

  const header = [
    "Phase".padEnd(20),
    "Token".padEnd(10),
    "Buys".padStart(5),
    "Sells".padStart(5),
    "Ratio".padStart(6),
    "Buy USD".padStart(12),
    "Sell USD".padStart(12),
    "SM Hold".padStart(8),
    "New Pos".padStart(8),
    "Close".padStart(6),
  ].join(" │ ");

  console.log(`  ${header}`);
  console.log(`  ${"─".repeat(header.length)}`);

  for (const t of tokens) {
    const emoji = phaseEmoji(t.phase);
    const row = [
      `${emoji} ${t.phase}`.padEnd(20),
      t.symbol.slice(0, 8).padEnd(10),
      String(t.buyCount).padStart(5),
      String(t.sellCount).padStart(5),
      t.ratio >= 99 ? "  ∞" : t.ratio.toFixed(1).padStart(6),
      `$${fmtCompact(t.buyUsd)}`.padStart(12),
      `$${fmtCompact(t.sellUsd)}`.padStart(12),
      String(t.smHolderCount).padStart(8),
      String(t.newPositions).padStart(8),
      String(t.closedPositions).padStart(6),
    ].join(" │ ");

    console.log(`  ${row}`);
  }

  console.log(`\n${"─".repeat(100)}`);

  // Summary
  const phases = {};
  for (const t of tokens) {
    phases[t.phase] = (phases[t.phase] || 0) + 1;
  }

  console.log(`\n  Phase Distribution:`);
  for (const [phase, count] of Object.entries(phases).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${phaseEmoji(phase)} ${phase}: ${count}`);
  }

  const actionable = tokens.filter((t) => t.score >= 3);
  if (actionable.length) {
    console.log(`\n  🎯 Actionable (Accumulation / Early Markup):`);
    for (const t of actionable) {
      console.log(`    ${t.symbol} — ${t.buyCount} buys / ${t.sellCount} sells ($${fmtCompact(t.buyUsd)} in) — ${t.smHolderCount} SM holders`);
    }
  }

  console.log();
}

function fmtCompact(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return `${n.toFixed(0)}`;
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
