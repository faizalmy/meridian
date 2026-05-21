/**
 * Close reason normalization.
 *
 * Maps any close_reason string to a fixed category for reliable
 * filtering, aggregation, and analytics. The raw reason is always
 * preserved — the category is additive.
 *
 * Categories: stop_loss, take_profit, trailing_tp, oor_above,
 * oor_below, oor, low_yield, agent, manual, unknown.
 */

/**
 * Normalize any close_reason string into a fixed category.
 * @param {string} reason - The raw close reason text
 * @returns {string} One of: stop_loss, take_profit, trailing_tp, oor_above,
 *   oor_below, oor, low_yield, agent, manual, unknown
 */
export function normalizeCloseReason(reason) {
  const r = String(reason || "").toLowerCase();

  // Stop loss — multiple formats across state.js and index.js
  // Check BEFORE trailing_tp because "Trailing TP stop loss" is a stop loss
  if (r.includes("stop loss") || r.includes("stop_loss")) return "stop_loss";

  // Take profit — hard TP (Rule 2)
  if (r.includes("take profit") || r.includes("take_profit")) return "take_profit";

  // OOR Below — price dropped below range (Rule 6)
  // Check BEFORE trailing_tp because "Trailing TP: OOR for X" is an OOR exit
  if (r.includes("oor below")) return "oor_below";

  // OOR Above — pumped far (Rule 3)
  if (r.includes("pumped far above range") || r.includes("rule 3")) return "oor_above";

  // OOR generic — timed out of range (Rule 4)
  // Check BEFORE trailing_tp because "Trailing TP: Out of range for X" is OOR-triggered
  if (r.includes("out of range") || r.includes("out_of_range")) return "oor";

  // Low yield — fee/TVL below threshold (Rule 5)
  // Check BEFORE trailing_tp because "Trailing TP: Low yield" is yield-triggered
  if (r.includes("low yield") || r.includes("fee/tvl")) return "low_yield";

  // Trailing TP — peak→drop confirmation (the pure trailing TP exit)
  // Only matches AFTER all compound-reason categories are checked
  if (r.includes("trailing tp")) return "trailing_tp";

  // Generic OOR catch-all (after trailing_tp to avoid false positives)
  if (r.includes("oor")) return "oor";

  // Agent decision — LLM chose to close
  if (r.includes("agent decision") || r.includes("agent")) return "agent";

  // Manual — user-initiated close
  if (r.includes("user requested") || r.includes("manual")) return "manual";

  return "unknown";
}
