/**
 * Config Snapshot — deterministic config hashing for traceability.
 *
 * Each config state is hashed (sorted JSON → SHA-256, first 12 chars) and
 * stored in config-snapshots.json. Same config = same hash = deduplicated.
 * This lets us trace which config was active when a position was deployed.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS_FILE = path.join(__dirname, "config-snapshots.json");

let _cache = null;

const SENSITIVE_KEYS = new Set(["apiKey", "publicApiKey", "walletKey"]);

/**
 * Deep-clone config and strip sensitive fields (API keys, wallet keys).
 */
function stripSensitive(config) {
  const clean = structuredClone(config);
  for (const section of [clean.hiveMind, clean.api, clean.jupiter]) {
    if (section && typeof section === "object") {
      for (const key of SENSITIVE_KEYS) {
        if (key in section) delete section[key];
      }
    }
  }
  return clean;
}

/**
 * Load snapshots from disk (cached in memory).
 */
function loadSnapshots() {
  if (_cache) return _cache;
  try {
    if (fs.existsSync(SNAPSHOTS_FILE)) {
      _cache = JSON.parse(fs.readFileSync(SNAPSHOTS_FILE, "utf8"));
    }
  } catch { /* ignore corrupt file */ }
  if (!_cache) _cache = { snapshots: {} };
  return _cache;
}

/**
 * Save snapshots to disk.
 */
function saveSnapshots(data) {
  try {
    fs.writeFileSync(SNAPSHOTS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    log("snapshot_warn", `Failed to save config-snapshots.json: ${err.message}`);
  }
}

/**
 * Deterministic hash of a config object.
 * Sorts keys deeply, serializes to JSON, then SHA-256 (first 12 chars).
 */
function hashConfig(config) {
  const sorted = JSON.stringify(config, Object.keys(config).sort());
  return createHash("sha256").update(sorted).digest("hex").slice(0, 12);
}

/**
 * Snapshot the config and return its hash.
 * Deduplicates: same config = same hash = no duplicate storage.
 * @param {object} config - The config object to snapshot.
 * @returns {string} 12-char hex hash identifying this config state.
 */
export function snapshotConfig(config) {
  const clean = stripSensitive(config);
  const hash = hashConfig(clean);
  const data = loadSnapshots();

  if (!data.snapshots[hash]) {
    data.snapshots[hash] = {
      config: clean,
      created_at: new Date().toISOString(),
    };
    saveSnapshots(data);
    log("snapshot", `New config snapshot: ${hash}`);
  }

  return hash;
}

/**
 * Retrieve a stored config snapshot by hash.
 * @param {string} hash - 12-char hex hash.
 * @returns {object|null} The stored { config, created_at } or null.
 */
export function getConfigSnapshot(hash) {
  const data = loadSnapshots();
  return data.snapshots[hash] || null;
}

/**
 * Get the current (most recent) config hash.
 * Returns null if no snapshot exists yet.
 * @returns {string|null}
 */
export function getCurrentConfigHash() {
  const data = loadSnapshots();
  const entries = Object.entries(data.snapshots);
  if (entries.length === 0) return null;
  // Return the most recently created snapshot
  return entries.sort((a, b) =>
    new Date(b[1].created_at) - new Date(a[1].created_at)
  )[0][0];
}
