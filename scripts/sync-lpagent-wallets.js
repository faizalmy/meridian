#!/usr/bin/env node

/**
 * Sync smart wallets from LP Agent API into meridian/smart-wallets.json.
 *
 * Usage:
 *   node scripts/sync-lpagent-wallets.js              # pull all
 *   node scripts/sync-lpagent-wallets.js --pages 5    # pull 5 pages only
 *   node scripts/sync-lpagent-wallets.js --dry-run    # preview
 */

import fs from "fs";
import path from "path";
import https from "https";
import { fileURLToPath } from "url";
import { addSmartWallet } from "../smart-wallets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── env ────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) { console.error("ERROR: .env not found"); process.exit(1); }
  const env = {};
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > -1) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

// ── CLI args ───────────────────────────────────────────────────

function parseArgs() {
  const a = process.argv.slice(2);
  const p = { pages: 0, pageSize: 12, orderBy: "total_pnl:desc", lastActivity: "7D", minWinRate: 0.2, minTotalLp: 500, minExpectedValue: 2, minRoi: 0, minPools: 0, dryRun: false };
  for (let i = 0; i < a.length; i++) {
    switch (a[i]) {
      case "--pages":       p.pages = +a[++i] || 0; break;
      case "--page-size":   p.pageSize = +a[++i] || 12; break;
      case "--min-roi":     p.minRoi = +a[++i] || 0; break;
      case "--min-pools":   p.minPools = +a[++i] || 0; break;
      case "--min-win":     p.minWinRate = +a[++i] / 100 || 0; break;
      case "--dry-run":     p.dryRun = true; break;
      case "--help":
        console.log(`
Usage: node scripts/sync-lpagent-wallets.js [options]

Options:
  --pages <n>       Pages to fetch (default: 0 = all ~1700 wallets)
  --min-roi <n>     Min ROI % (default: 0)
  --min-pools <n>   Min pools traded (default: 0)
  --min-win <n>     Min win rate % (default: 20)
  --dry-run         Preview without saving
`);
        process.exit(0);
    }
  }
  return p;
}

// ── API ────────────────────────────────────────────────────────

function apiGet(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve({ status: res.statusCode, data: JSON.parse(body) }); } catch { resolve({ status: res.statusCode, data: null }); } });
    }).on("error", reject);
  });
}

async function fetchPage(env, params, page) {
  const qs = new URLSearchParams({
    page: String(page), pageSize: String(params.pageSize), orderBy: params.orderBy,
    lastActivity: params.lastActivity, firstActivity: "",
    minWinRate: String(params.minWinRate), minTotalLp: String(params.minTotalLp),
    minAvgAgeHour: "0", minExpectedValue: String(params.minExpectedValue),
  });
  return apiGet(`https://api.lpagent.io/api/v1/smart-lp?${qs}`, {
    accept: "application/json, text/plain, */*",
    authorization: `Bearer ${env.LPAGENT_BEARER_TOKEN}`,
    chain: "SOL", origin: "https://app.lpagent.io", referer: "https://app.lpagent.io/",
    "x-turnstile-token": env.LPAGENT_TURNSTILE_TOKEN,
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  });
}

// ── convert ────────────────────────────────────────────────────

function toMeta(w) {
  return {
    pools: w.total_pool,
    totalPnl: +(w.total_pnl).toFixed(2),
    totalInflow: +(w.total_inflow).toFixed(2),
    avgRoiPct: +(w.roi * 100).toFixed(2),
    winRate: +(w.win_rate * 100).toFixed(2),
    totalLp: w.total_lp,
    avgAgeHour: +(w.avg_age_hour).toFixed(1),
    expectedValue: +(w.expected_value).toFixed(2),
    fee: +(w.total_fee).toFixed(2),
    lastSyncedAt: new Date().toISOString(),
  };
}

// ── main ───────────────────────────────────────────────────────

async function main() {
  const env = loadEnv();
  const params = parseArgs();

  if (!env.LPAGENT_BEARER_TOKEN || !env.LPAGENT_TURNSTILE_TOKEN) {
    console.error("ERROR: LPAGENT_BEARER_TOKEN or LPAGENT_TURNSTILE_TOKEN missing from .env");
    process.exit(1);
  }

  const allPages = params.pages === 0;
  console.log(`LP Agent → Smart Wallets  (dryRun=${params.dryRun})`);
  console.log(`  pages=${allPages ? "all" : params.pages}  minRoi=${params.minRoi}%  minPools=${params.minPools}\n`);

  // ── fetch ──
  const allRaw = [];
  let page = 1;
  const maxPages = allPages ? 200 : params.pages; // safety cap

  while (page <= maxPages) {
    process.stdout.write(`  Page ${page}... `);
    const res = await fetchPage(env, params, page);
    if (res.status === 401) { console.error("\nERROR: 401 — tokens expired."); process.exit(1); }
    if (res.status !== 200 || !res.data) { console.error(`\nERROR: HTTP ${res.status}`); process.exit(1); }

    const wallets = res.data?.data?.smart_lp || [];
    if (wallets.length === 0) { console.log("empty → done"); break; }

    const filtered = wallets.filter(
      (w) => w.total_pool >= params.minPools && (params.minRoi <= 0 || w.roi * 100 >= params.minRoi)
    );
    console.log(`${wallets.length} raw → ${filtered.length} kept`);
    allRaw.push(...filtered);
    page++;
  }

  console.log(`\n  Total fetched: ${allRaw.length} wallets\n`);

  if (allRaw.length === 0) { console.log("Nothing to sync."); return; }

  // ── merge via addSmartWallet ──
  let added = 0, updated = 0, failed = 0;
  for (const w of allRaw) {
    const addr = w.owner;
    const name = `lp_${addr.slice(0, 8)}`;
    const meta = toMeta(w);

    const result = addSmartWallet({ name, address: addr, category: "alpha", type: "lp", meta });
    if (result.success) {
      if (result.added) added++;
      else if (result.updated) updated++;
    } else {
      console.log(`  SKIP ${name}: ${result.error}`);
      failed++;
    }
  }

  console.log(`${params.dryRun ? "[DRY RUN] " : ""}Done:`);
  console.log(`  Added:   ${added}`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Failed:  ${failed}`);
}

main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });
