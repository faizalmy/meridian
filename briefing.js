import fs from "fs";
import { log } from "./logger.js";
import { getPerformanceSummary } from "./lessons.js";
import { fetchSmartMoneyTrades, fetchKolTrades, detectClusterSignals } from "./tools/gmgn.js";

const STATE_FILE = "./state.json";
const LESSONS_FILE = "./lessons.json";

export async function generateBriefing() {
  const state = loadJson(STATE_FILE) || { positions: {}, recentEvents: [] };
  const lessonsData = loadJson(LESSONS_FILE) || { lessons: [], performance: [] };

  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // 1. Positions Activity
  const allPositions = Object.values(state.positions || {});
  const openedLast24h = allPositions.filter(p => new Date(p.deployed_at) > last24h);
  const closedLast24h = allPositions.filter(p => p.closed && new Date(p.closed_at) > last24h);

  // 2. Performance Activity (from performance log)
  const perfLast24h = (lessonsData.performance || []).filter(p => new Date(p.recorded_at) > last24h);
  const totalPnLUsd = perfLast24h.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
  const totalFeesUsd = perfLast24h.reduce((sum, p) => sum + (p.fees_earned_usd || 0), 0);

  // 3. Lessons Learned
  const lessonsLast24h = (lessonsData.lessons || []).filter(l => new Date(l.created_at) > last24h);

  // 4. Current State
  const openPositions = allPositions.filter(p => !p.closed);
  const perfSummary = getPerformanceSummary();

  // 5. GMGN Smart Money Activity (fail-open)
  let gmgnSection = null;
  try {
    const [smartMoneyTrades, kolTrades] = await Promise.all([
      fetchSmartMoneyTrades("sol", 100).catch(() => []),
      fetchKolTrades("sol", 50).catch(() => []),
    ]);

    const allTrades = [...smartMoneyTrades, ...kolTrades];
    if (allTrades.length > 0) {
      // Classify trades
      const buys = allTrades.filter(t => t.side === "buy" || t.direction === "buy" || t.is_buy === true);
      const sells = allTrades.filter(t => t.side === "sell" || t.direction === "sell" || t.is_buy === false);

      const buyUsd = buys.reduce((s, t) => s + parseFloat(t.usd_amount || t.amount_usd || t.value || "0"), 0);
      const sellUsd = sells.reduce((s, t) => s + parseFloat(t.usd_amount || t.amount_usd || t.value || "0"), 0);

      // Top tokens by trade volume
      const tokenVolume = {};
      for (const t of allTrades) {
        const token = t.base_symbol || t.symbol || t.token_symbol || "UNKNOWN";
        if (!tokenVolume[token]) tokenVolume[token] = { buyUsd: 0, sellUsd: 0, buys: 0, sells: 0 };
        const usd = parseFloat(t.usd_amount || t.amount_usd || t.value || "0");
        const isBuy = t.side === "buy" || t.direction === "buy" || t.is_buy === true;
        if (isBuy) { tokenVolume[token].buyUsd += usd; tokenVolume[token].buys++; }
        else { tokenVolume[token].sellUsd += usd; tokenVolume[token].sells++; }
      }

      // Top 3 buy tokens
      const topBuys = Object.entries(tokenVolume)
        .sort((a, b) => b[1].buyUsd - a[1].buyUsd)
        .slice(0, 3)
        .filter(([, v]) => v.buyUsd > 0);

      // Top 3 sell tokens
      const topSells = Object.entries(tokenVolume)
        .sort((a, b) => b[1].sellUsd - a[1].sellUsd)
        .slice(0, 3)
        .filter(([, v]) => v.sellUsd > 0);

      // Cluster signals
      const clusters = detectClusterSignals(allTrades, 60);

      gmgnSection = { buys, sells, buyUsd, sellUsd, topBuys, topSells, clusters };
    }
  } catch {
    // Fail-open: GMGN data unavailable, skip section
  }

  // 6. Format Message
  const lines = [
    "☀️ <b>Morning Briefing</b> (Last 24h)",
    "────────────────",
    `<b>Activity:</b>`,
    `📥 Positions Opened: ${openedLast24h.length}`,
    `📤 Positions Closed: ${closedLast24h.length}`,
    "",
    `<b>Performance:</b>`,
    `💰 Net PnL: ${totalPnLUsd >= 0 ? "+" : ""}$${totalPnLUsd.toFixed(2)}`,
    `💎 Fees Earned: $${totalFeesUsd.toFixed(2)}`,
    perfLast24h.length > 0
      ? `📈 Win Rate (24h): ${Math.round((perfLast24h.filter(p => p.pnl_usd > 0).length / perfLast24h.length) * 100)}%`
      : "📈 Win Rate (24h): N/A",
    "",
    `<b>Lessons Learned:</b>`,
    lessonsLast24h.length > 0
      ? lessonsLast24h.map(l => `• ${l.rule}`).join("\n")
      : "• No new lessons recorded overnight.",
    "",
    `<b>Current Portfolio:</b>`,
    `📂 Open Positions: ${openPositions.length}`,
    perfSummary
      ? `📊 All-time PnL: $${perfSummary.total_pnl_usd.toFixed(2)} (${perfSummary.win_rate_pct}% win)`
      : "",
    "",
  ];

  // GMGN Smart Money Activity (conditional)
  if (gmgnSection) {
    const { buys, sells, buyUsd, sellUsd, topBuys, topSells, clusters } = gmgnSection;
    const netDir = buyUsd > sellUsd ? "Net Buy" : buyUsd < sellUsd ? "Net Sell" : "Neutral";
    const netUsd = Math.abs(buyUsd - sellUsd);

    lines.push(
      `<b>Smart Money Activity (24h):</b>`,
      `🔄 ${buys.length} buys ($${buyUsd.toFixed(0)}) / ${sells.length} sells ($${sellUsd.toFixed(0)})`,
      `🧭 Direction: <b>${netDir}</b> ($${netUsd.toFixed(0)})`,
    );

    if (topBuys.length > 0) {
      lines.push(`📈 Top Buys: ${topBuys.map(([sym, v]) => `${sym} $${v.buyUsd.toFixed(0)}`).join(", ")}`);
    }
    if (topSells.length > 0) {
      lines.push(`📉 Top Sells: ${topSells.map(([sym, v]) => `${sym} $${v.sellUsd.toFixed(0)}`).join(", ")}`);
    }
    if (clusters.length > 0) {
      const strong = clusters.filter(c => c.signalStrength === "strong" || c.signalStrength === "very_strong");
      if (strong.length > 0) {
        lines.push(`🔥 Cluster Signals: ${strong.map(c => `${c.token.slice(0, 6)}... (${c.direction}, ${c.walletCount} wallets)`).join(", ")}`);
      }
    }
    lines.push("");
  }

  lines.push("────────────────");

  return lines.join("\n");
}

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    log("briefing_error", `Failed to read ${file}: ${err.message}`);
    return null;
  }
}
