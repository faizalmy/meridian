// telegram-formatter.js — Deterministic message building for Telegram
// LLM outputs decisions only. This module builds the final HTML.

// ─── HTML Helpers ──────────────────────────────────────────────

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function bold(text) {
  return `<b>${text}</b>`;
}

function code(text) {
  return `<code>${text}</code>`;
}

function italic(text) {
  return `<i>${text}</i>`;
}

// ─── Data Formatting ───────────────────────────────────────────

function formatAge(minutes) {
  if (minutes == null) return '?';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatUSD(value) {
  if (value == null) return '?';
  return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatSOL(value) {
  if (value == null) return '?';
  return `${Number(value).toFixed(4)} SOL`;
}

function formatPct(value, showSign = true) {
  if (value == null) return '?';
  const sign = showSign && value >= 0 ? '+' : '';
  return `${sign}${Number(value).toFixed(2)}%`;
}

function formatPrice(value) {
  if (value == null) return '?';
  if (value < 0.0001) return value.toExponential(3);
  return value.toFixed(6);
}

// ─── Progress Bar ──────────────────────────────────────────────

function buildRangeBar(p, width = 10) {
  if (p.lower_bin == null || p.upper_bin == null || p.active_bin == null) return null;
  const range = p.upper_bin - p.lower_bin;
  if (range <= 0) return null;

  const ratio = (p.active_bin - p.lower_bin) / range;

  // Build the visual bar
  let bar;
  if (p.in_range) {
    const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
    const empty = width - filled;
    bar = `[${'▓'.repeat(filled)}${'░'.repeat(empty)}]`;
  } else if (ratio < 0) {
    bar = `◀[${'░'.repeat(width)}]`;
  } else {
    bar = `[${'▓'.repeat(width)}]▶`;
  }

  // Range percentage (requires bin_step)
  if (p.bin_step != null) {
    const stepMul = 1 + p.bin_step / 10000;
    const pctToLower = (stepMul ** (p.lower_bin - p.active_bin) - 1) * 100;
    const pctToUpper = (stepMul ** (p.upper_bin - p.active_bin) - 1) * 100;
    bar += ` ${pctToLower >= 0 ? '+' : ''}${pctToLower.toFixed(1)}% / ${pctToUpper >= 0 ? '+' : ''}${pctToUpper.toFixed(1)}%`;
  }

  return code(bar);
}

// ─── Exit label helper ──────────────────────────────────────────

function getExitLabel(reason) {
  const r = reason || '';
  if (/out of range/i.test(r)) return '📡 OOR:';
  if (/stop loss/i.test(r)) return '🛑 SL:';
  if (/trailing/i.test(r)) return '⚡ Trailing TP:';
  if (/low yield/i.test(r)) return '📉 Low yield:';
  if (/rule 3/i.test(r)) return '📏 Rule 3:';
  if (/rule 4/i.test(r)) return '📏 Rule 4:';
  return '⚡ Exit:';
}

// ─── Management Report ─────────────────────────────────────────

function formatManagementReport(positions, actionMap, portfolio) {
  const cur = portfolio.solMode ? '◎' : '$';

  const lines = positions.map((p) => {
    const act = actionMap.get(p.position);
    const inRange = p.in_range ? '🟢 IN' : `🔴 OOR ${p.minutes_out_of_range ?? 0}m`;
    const val = portfolio.solMode
      ? `◎${p.total_value_usd != null ? Number(p.total_value_usd).toFixed(4) : '?'}`
      : formatUSD(p.total_value_usd);
    const unclaimed = portfolio.solMode
      ? `◎${p.unclaimed_fees_usd != null ? Number(p.unclaimed_fees_usd).toFixed(4) : '?'}`
      : formatUSD(p.unclaimed_fees_usd);
    const statusLabel = act.action === 'INSTRUCTION' ? 'HOLD (instruction)' : act.action;
    const pnlStr = p.pnl_usd != null
      ? `${p.pnl_usd >= 0 ? '' : '-'}${cur}${Math.abs(p.pnl_usd).toFixed(2)}`
      : '?';
    const pnlPctStr = p.pnl_pct != null ? ` (${formatPct(p.pnl_pct)})` : '';

    let line = `${bold(p.pair)} | Age: ${formatAge(p.age_minutes)} | Val: ${val} | Unclaimed: ${unclaimed} | PnL: ${pnlStr}${pnlPctStr} | Yield: ${formatPct(p.fee_per_tvl_24h)} | ${inRange} | ${statusLabel}`;

    const bar = buildRangeBar(p);
    if (bar) line += `\n${bar}`;

    if (p.instruction) line += `\nNote: "${p.instruction}"`;
    if (act.action === 'CLOSE' && act.rule === 'exit') line += `\n${getExitLabel(act.reason)} ${escapeHtml(act.reason)}`;
    if (act.action === 'CLOSE' && act.rule && act.rule !== 'exit') line += `\nRule ${act.rule}: ${escapeHtml(act.reason)}`;
    if (act.action === 'CLAIM') line += `\n→ Claiming fees`;

    return line;
  });

  const needsAction = [...actionMap.values()].filter(a => a.action !== 'STAY');
  const actionSummary = needsAction.length > 0
    ? needsAction.map(a => a.action === 'INSTRUCTION' ? 'EVAL instruction' : `${a.action}${a.reason ? ` (${escapeHtml(a.reason)})` : ''}`).join(', ')
    : 'no action';

  return lines.join('\n\n') +
    `\n\n${bold('Summary:')} 💼 ${positions.length} positions | ${cur}${portfolio.totalValue.toFixed(4)} | fees: ${cur}${portfolio.totalUnclaimed.toFixed(4)} | ${actionSummary}`;
}

// ─── Filter Summary ────────────────────────────────────────────

function categorizeFilterReason(reason) {
  const r = reason || '';
  if (/^mcap .+ below minMcap/.test(r)) return 'mcap too low';
  if (/^mcap .+ above maxMcap/.test(r)) return 'mcap too high';
  if (/^holders .+ below minHolders/.test(r)) return 'holders too low';
  if (/^volume .+ below minVolume/.test(r)) return 'volume too low';
  if (/^TVL .+ below minTvl/.test(r)) return 'TVL too low';
  if (/^TVL .+ above maxTvl/.test(r)) return 'TVL too high';
  if (/^bin_step .+ below minBinStep/.test(r)) return 'bin step too low';
  if (/^bin_step .+ above maxBinStep/.test(r)) return 'bin step too high';
  if (/^fee\/active-TVL .+ below/.test(r)) return 'low fee/TVL ratio';
  if (/^volatility .+ unusable/.test(r)) return 'unusable volatility';
  if (/^base organic .+ below/.test(r)) return 'low organic score';
  if (/^quote organic .+ below/.test(r)) return 'low quote organic';
  if (/^quote token .+ is not SOL/.test(r)) return 'not SOL paired';
  if (/blocked launchpad/.test(r)) return 'blocked launchpad';
  if (/launchpad .+ not in allow-list/.test(r)) return 'launchpad not allowed';
  if (/token age below/.test(r)) return 'token too new';
  if (/token age above/.test(r)) return 'token too old';
  if (/pool cooldown/.test(r)) return 'pool cooldown';
  if (/token cooldown/.test(r)) return 'token cooldown';
  if (/already have an open position/.test(r)) return 'existing position';
  if (/already holding this base token/.test(r)) return 'duplicate token';
  if (/PVP hard filter/.test(r)) return 'PVP filter';
  if (/wash trading/.test(r)) return 'wash trading';
  if (/blocked deployer/.test(r)) return 'blocked deployer';
  if (/bot holders/.test(r)) return 'high bot holders';
  if (/sell pressure/.test(r)) return 'high sell pressure';
  if (/token fees .+ below minimum/.test(r)) return 'low token fees';
  if (/rugpull risk/.test(r)) return 'rugpull risk';
  if (/PVP conflict/.test(r)) return 'PVP conflict';
  if (/top10 concentration/.test(r)) return 'high top10 concentration';
  if (/no narrative and no smart wallets/.test(r)) return 'weak candidate';
  if (/indicator reject/.test(r)) return 'indicator reject';
  if (/\d+% of ATH/.test(r)) return 'near ATH';
  if (/high supply concentration/.test(r)) return 'supply concentration';
  if (/critical warnings/.test(r)) return 'critical warnings';
  if (/high single ownership/.test(r)) return 'high ownership';
  if (/pool_type .+ is not dlmm/.test(r)) return 'not DLMM pool';
  return 'other';
}

function aggregateFilterReasons(examples) {
  if (!examples || examples.length === 0) return [];
  const counts = {};
  for (const ex of examples) {
    const cat = categorizeFilterReason(ex.reason);
    counts[cat] = (counts[cat] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, count]) => `${cat}: ${count}`);
}

function formatFilterSummary(filteredExamples) {
  if (!filteredExamples || filteredExamples.length === 0) return [];
  const aggregated = aggregateFilterReasons(filteredExamples);
  if (aggregated.length === 0) return [];
  return [
    '',
    `${bold('🛡️ Filter Summary')} (${filteredExamples.length} rejected)`,
    ...aggregated.map((line) => `• ${line}`),
  ];
}

// ─── Screening Report ──────────────────────────────────────────

function formatScreeningReport(candidates, decision, portfolio, filteredExamples) {
  if (decision.action === 'skip') {
    return formatScreeningSkip(candidates, decision, portfolio, filteredExamples);
  }
  return formatScreeningDeploy(candidates, decision, portfolio);
}

function formatScreeningDeploy(candidates, decision, portfolio, filteredExamples) {
  const candidate = candidates.find(c => c.pool.name === decision.pair);
  if (!candidate) return `${bold('🔍 Screening')} — no data available`;

  const { pool, sw, ti, ds } = candidate;

  const confidenceLevels = {
    very_high: { label: 'VERY HIGH', emoji: '🟢🟢' },
    high: { label: 'HIGH', emoji: '🟢' },
    medium_high: { label: 'MEDIUM-HIGH', emoji: '🟡🟢' },
    medium: { label: 'MEDIUM', emoji: '🟡' },
    medium_low: { label: 'MEDIUM-LOW', emoji: '🟠🟡' },
    low: { label: 'LOW', emoji: '🔴' },
    very_low: { label: 'VERY LOW', emoji: '🔴🔴' },
  };
  const confKey = String(decision.confidence || 'medium').toLowerCase().replace(/\s+/g, '_');
  const confidence = confidenceLevels[confKey] || confidenceLevels.medium;

  const lines = [
    `${bold('🔍 Screening Complete')}`,
    '',
    `${bold('🚀 Deploy:')} ${pool.name} — ${confidence.emoji} ${confidence.label}`,
    '━'.repeat(32),
    '',
    `${bold('💡 Summary')}`,
    decision.summary || 'No summary provided',
    '',
    `${bold('📊 Market Data')}`,
    `Token age: ${pool.token_age_hours ?? '?'}h | Holders: ${ti?.holders ?? '?'}`,
    `Smart money: ${sw?.in_pool?.length ? `${sw.in_pool.length} wallets present` : 'none'}`,
  ];

  if (ds) {
    const buyPct = ds.ds_buy_pct_1h != null ? `${ds.ds_buy_pct_1h.toFixed(0)}%` : '?';
    const ratio = ds.ds_buy_ratio_1h != null ? ds.ds_buy_ratio_1h.toFixed(2) : '?';
    const buyTag = ds.ds_buy_pct_1h != null ? (ds.ds_buy_pct_1h > 55 ? '🟢' : ds.ds_buy_pct_1h < 45 ? '🔴' : '🟡') : '⚪';
    const parts = [];
    if (ds.ds_buys_1h != null) parts.push(`${ds.ds_buys_1h} buys`);
    if (ds.ds_sells_1h != null) parts.push(`${ds.ds_sells_1h} sells`);
    lines.push(
      '',
      `${bold('📈 DexScreener (1h)')}`,
      `${buyTag} Buy/sell: ${parts.join(' / ')} (${buyPct} buys, ratio ${ratio})`,
    );
    const priceParts = [];
    if (ds.ds_price_change_5m != null) priceParts.push(`5m ${ds.ds_price_change_5m > 0 ? '+' : ''}${ds.ds_price_change_5m.toFixed(1)}%`);
    if (ds.ds_price_change_1h != null) priceParts.push(`1h ${ds.ds_price_change_1h > 0 ? '+' : ''}${ds.ds_price_change_1h.toFixed(1)}%`);
    if (ds.ds_price_change_6h != null) priceParts.push(`6h ${ds.ds_price_change_6h > 0 ? '+' : ''}${ds.ds_price_change_6h.toFixed(1)}%`);
    if (ds.ds_price_change_24h != null) priceParts.push(`24h ${ds.ds_price_change_24h > 0 ? '+' : ''}${ds.ds_price_change_24h.toFixed(1)}%`);
    if (priceParts.length) lines.push(`Price Δ: ${priceParts.join(' | ')}`);
    if (ds.ds_liquidity_usd != null) lines.push(`Liquidity: $${ds.ds_liquidity_usd.toLocaleString()}`);
    if (ds.ds_boosts_active) lines.push(`Boosts: ${ds.ds_boosts_active} active`);
  }

  lines.push(
    '',
    `${bold('🛡️ Risk Assessment')}`,
    `${pool.risk_level === 1 ? '🟢' : '🟡'} Risk level: ${pool.risk_level ?? '?'}`,
    `${pool.is_rugpull ? '❌' : '✅'} Rugpull: ${pool.is_rugpull ? 'YES' : 'NO'}`,
    `${pool.is_wash ? '❌' : '✅'} Wash: ${pool.is_wash ? 'YES' : 'NO'}`,
  );

  lines.push(...formatFilterSummary(filteredExamples));

  return lines.join('\n');
}

function formatScreeningSkip(candidates, decision, portfolio, filteredExamples) {
  const lines = [
    `${bold('🔍 Screening Complete')}`,
    '',
    `${bold('⛔ No Deploy')}`,
    '',
    `${bold('Reason:')} ${decision.reason}`,
  ];

  if (candidates.length > 0) {
    lines.push('', bold('Rejected:'));
    candidates.forEach(c => {
      lines.push(`- ${c.pool.name}: ${c.skipReason || 'failed filters'}`);
    });
  }

  lines.push(...formatFilterSummary(filteredExamples));

  return lines.join('\n');
}

// ─── Deploy Notification ───────────────────────────────────────

function formatDeployNotification(data) {
  const { pair, amountSol, strategy, activeBin, priceRange, rangeCoverage, binStep, baseFee } = data;

  const lines = [
    `${bold('🚀 Deployed')} ${pair}`,
    '',
    `Amount: ${amountSol} SOL`,
  ];

  if (priceRange) {
    lines.push(`Range: ${formatPrice(priceRange.min)} → ${formatPrice(priceRange.max)}`);
  }

  if (rangeCoverage) {
    lines.push(`Range cover: ${formatPct(rangeCoverage.downside_pct)} downside | ${formatPct(rangeCoverage.upside_pct)} upside | ${formatPct(rangeCoverage.width_pct)} total`);
  }

  if (binStep || baseFee) {
    lines.push(`Bin step: ${binStep ?? '?'} | Base fee: ${baseFee != null ? baseFee + '%' : '?'}`);
  }

  return lines.join('\n');
}

// ─── Close Notification ────────────────────────────────────────

function formatCloseNotification(data) {
  const { pair, pnlUsd, pnlPct, reason } = data;

  const reasonLine = reason ? `Reason: ${escapeHtml(reason)}` : '';
  const profit = (pnlUsd ?? 0) >= 0;
  const icon = profit ? '🟢' : '🔴';
  const pnlStr = `${profit ? '' : '-'}$${Math.abs(pnlUsd ?? 0).toFixed(2)}`;
  const pctStr = formatPct(pnlPct);

  const lines = [
    `${icon} ${bold('Closed')} ${pair}`,
    `PnL: ${pnlStr} (${pctStr})`,
  ];

  if (reasonLine) lines.push(reasonLine);

  return lines.join('\n');
}

// ─── Parse LLM Decision ───────────────────────────────────────

function parseDecision(text) {
  if (!text || typeof text !== 'string') {
    return { action: 'skip', reason: 'Could not parse LLM decision' };
  }

  const SKIP = { action: 'skip', reason: 'Could not parse LLM decision' };

  try {
    // Strip markdown code fences
    const cleaned = text.replace(/```(?:json)?\s*/gi, '').trim();

    // Try parsing the whole cleaned text
    try {
      return JSON.parse(cleaned);
    } catch (_) {}

    // Extract between first { and last }
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) {
      try {
        return JSON.parse(cleaned.slice(first, last + 1));
      } catch (_) {}
    }

    // No JSON found — infer decision from text keywords (deepseek non-compliance fallback)
    return inferDecisionFromText(cleaned);
  } catch (_) {
    return SKIP;
  }
}

/**
 * Infer LLM decision from free-form text when no JSON is present.
 * Handles deepseek-v4-flash non-compliance: outputs analysis text without JSON.
 * Deploy indicators are checked first (conservative — only infer deploy on clear signals).
 * Default fallback is skip (safer than deploying without structured decision).
 */
function inferDecisionFromText(text) {
  const lower = text.toLowerCase();

  // Deploy indicators — LLM successfully deployed but forgot JSON
  // Must be specific: "deployed", "deploying", "position opened", NOT just "deployment" in context like "deployment standards"
  if (/\b(deploy(?:ed|ing)|position opened|successfully (?:opened|created|added))\b/i.test(lower)) {
    return { action: 'deploy', summary: text.slice(0, 200) };
  }

  // Skip indicators — LLM analyzed and found issues
  if (/\b(skip|fail(?:s|ed|ing)?|reject(?:ed|ing)?|no deploy|not (?:worth|eligible)|does? not meet|insufficient|avoid)\b/i.test(lower)) {
    return { action: 'skip', reason: text.slice(0, 200) };
  }

  // Default: LLM wrote analysis text without clear decision — treat as skip
  // (safer than deploying without structured JSON)
  return { action: 'skip', reason: text.slice(0, 200) };
}

// ─── Markdown Stripping ────────────────────────────────────────

/**
 * Strip markdown formatting from LLM output for Telegram HTML parse mode.
 * Converts markdown to plain text (or HTML where safe).
 */
function stripMarkdown(text) {
  if (!text) return text;
  let s = String(text);

  // <thinking>...</thinking> and <think>...</think>
  s = s.replace(/<(?:redacted_)?thinking>[\s\S]*?<\/(?:redacted_)?thinking>/gi, "");
  // Leaked / obfuscated tags: ZWSP splits "<" from "thinking" (no literal "<" before "thinking")
  const z = "\u200B";
  s = s.replace(
    new RegExp(
      z +
        "?thinking" +
        z +
        "?>[^<]*?<\\/" +
        z +
        "?thinking" +
        z +
        "?>",
      "gi",
    ),
    "",
  );

  // Remove fenced code blocks; collapse extra blank lines left around the fence
  s = s.replace(/\n*```[\s\S]*?```\n*/g, "\n");

  // Remove inline code: `code`
  s = s.replace(/`([^`\n]+)`/g, '$1');

  // Remove bold: **text** or __text__
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');

  // Remove italic: *text* or _text_
  s = s.replace(/(?<!\*)\*(?!\*)([^*]+)(?<!\*)\*(?!\*)/g, '$1');
  s = s.replace(/(?<!_)_(?!_)([^_]+)(?<!_)_(?!_)/g, '$1');

  // Remove strikethrough: ~~text~~
  s = s.replace(/~~([^~]+)~~/g, '$1');

  // Remove headings: ### text → text
  s = s.replace(/^#{1,6}\s+/gm, '');

  // Remove blockquotes: > text → text
  s = s.replace(/^>\s?/gm, '');

  // Remove horizontal rules: --- or *** or ___
  s = s.replace(/^[-*_]{3,}\s*$/gm, '');

  // Remove unordered list markers: - item or * item → • item
  s = s.replace(/^(\s*)[-*]\s+/gm, '$1• ');

  // Remove ordered list markers: 1. item → • item
  s = s.replace(/^(\s*)\d+\.\s+/gm, '$1• ');

  // Remove link syntax: [text](url) → text
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Remove image syntax: ![alt](url)
  s = s.replace(/!\[([^\]]*)\]\([^)]+\)/g, '');

  // Remove HTML tags that LLMs sometimes emit
  s = s.replace(/<\/?(?:p|br|hr|div|span|pre|blockquote|ul|ol|li|h[1-6])[^>]*>/gi, '');

  return s.trim();
}

// ─── Exports ───────────────────────────────────────────────────

export {
  // HTML helpers
  bold,
  code,
  italic,
  escapeHtml,

  // Data formatting
  formatAge,
  formatUSD,
  formatSOL,
  formatPct,
  formatPrice,

  // Progress bar
  buildRangeBar,

  // Report formatters
  formatManagementReport,
  getExitLabel,
  formatScreeningReport,
  formatDeployNotification,
  formatCloseNotification,

  // LLM parsing
  parseDecision,

  // Markdown stripping
  stripMarkdown,
};