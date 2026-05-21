#!/usr/bin/env node
/**
 * Backfill close_reason_category on existing lessons.json performance records.
 * Run once after deploying close-reason.js. Idempotent — skips records that
 * already have close_reason_category.
 *
 * Usage: node scripts/backfill-close-reason-category.js [--dry-run]
 */

import fs from "fs";
import { normalizeCloseReason } from "../close-reason.js";

const LESSONS_PATH = "./lessons.json";
const isDryRun = process.argv.includes("--dry-run");

const data = JSON.parse(fs.readFileSync(LESSONS_PATH, "utf8"));
const perf = data.performance || [];

let updated = 0;
let skipped = 0;

for (const entry of perf) {
  if (entry.close_reason_category) {
    skipped++;
    continue;
  }
  entry.close_reason_category = normalizeCloseReason(entry.close_reason);
  updated++;
}

console.log(`Total records: ${perf.length}`);
console.log(`Updated: ${updated}`);
console.log(`Already had category: ${skipped}`);

if (!isDryRun && updated > 0) {
  fs.writeFileSync(LESSONS_PATH, JSON.stringify(data, null, 2));
  console.log("Written to lessons.json");
} else if (isDryRun && updated > 0) {
  console.log("(dry run — not written)");
}

// Show category distribution
const cats = {};
for (const entry of perf) {
  const cat = entry.close_reason_category || "unset";
  cats[cat] = (cats[cat] || 0) + 1;
}
console.log("\nCategory distribution:");
for (const [cat, count] of Object.entries(cats).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cat}: ${count} (${(count * 100 / perf.length).toFixed(1)}%)`);
}
