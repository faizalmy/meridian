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
    if (act.action === 'CLOSE' && act.rule === 'exit') {
      const reason = act.reason || '';
      let icon = '⚡';
      if (/out of range/i.test(reason)) icon = '📡 OOR:';
      else if (/stop loss/i.test(reason)) icon = '🛑 SL:';
      else if (/trailing/i.test(reason)) icon = '⚡ Trailing TP:';
      else if (/low yield/i.test(reason)) icon = '📉 Low yield:';
      else if (/rule 3/i.test(reason)) icon = '📏 Rule 3:';
      else if (/rule 4/i.test(reason)) icon = '📏 Rule 4:';
      else icon = '⚡ Exit:';
      line += `\n${icon} ${escapeHtml(reason)}`;
    }
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

// ─── Screening Report ──────────────────────────────────────────

function formatScreeningReport(candidates, decision, portfolio) {
  if (decision.action === 'skip') {
    return formatScreeningSkip(candidates, decision, portfolio);
  }
  return formatScreeningDeploy(candidates, decision, portfolio);
}

function formatScreeningDeploy(candidates, decision, portfolio) {
  const candidate = candidates.find(c => c.pool.name === decision.pair);
  if (!candidate) return `${bold('🔍 Screening')} — no data available`;

  const { pool, sw, ti } = candidate;

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
    '',
    `${bold('🛡️ Risk Assessment')}`,
    `${pool.risk_level === 1 ? '🟢' : '🟡'} Risk level: ${pool.risk_level ?? '?'}`,
    `${pool.is_rugpull ? '❌' : '✅'} Rugpull: ${pool.is_rugpull ? 'YES' : 'NO'}`,
    `${pool.is_wash ? '❌' : '✅'} Wash: ${pool.is_wash ? 'YES' : 'NO'}`,
  ];

  return lines.join('\n');
}

function formatScreeningSkip(candidates, decision, portfolio) {
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
  try {
    // Extract JSON from LLM response
    const jsonMatch = text.match(/\{[^}]+\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    // Fallback: treat as skip
  }
  return { action: 'skip', reason: 'Could not parse LLM decision' };
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
  formatScreeningReport,
  formatDeployNotification,
  formatCloseNotification,

  // LLM parsing
  parseDecision,
};
