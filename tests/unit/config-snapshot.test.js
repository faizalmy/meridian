import { describe, it, expect, beforeEach, vi } from "vitest";
import { setupMockFs, seedMockFs, getMockFs, resetMockFs } from "../helpers/mock-fs.js";

setupMockFs();

vi.mock("../../logger.js", () => ({
  log: vi.fn(),
}));

const SNAPSHOTS_FILE = "/Users/faizal/Sites/games/aiagents/meridian/config-snapshots.json";

let mod;
async function loadModule() {
  resetMockFs();
  vi.resetModules();
  mod = await import("../../config-snapshot.js");
}

describe("config-snapshot", () => {
  beforeEach(async () => {
    await loadModule();
  });

  describe("snapshotConfig() determinism", () => {
    it("same config object produces same hash", () => {
      const config = { a: 1, b: "hello", c: true };
      const h1 = mod.snapshotConfig(config);
      const h2 = mod.snapshotConfig(config);
      expect(h1).toBe(h2);
    });

    it("different config produces different hash", () => {
      const h1 = mod.snapshotConfig({ a: 1 });
      const h2 = mod.snapshotConfig({ a: 2 });
      expect(h1).not.toBe(h2);
    });

    it("hash is a 12-char hex string", () => {
      const hash = mod.snapshotConfig({ test: true });
      expect(hash).toMatch(/^[0-9a-f]{12}$/);
    });
  });

  describe("snapshotConfig() storage", () => {
    it("snapshot is stored in config-snapshots.json", () => {
      mod.snapshotConfig({ x: 1 });
      const files = getMockFs();
      expect(files[SNAPSHOTS_FILE]).toBeDefined();

      const stored = JSON.parse(files[SNAPSHOTS_FILE]);
      expect(stored.snapshots).toBeDefined();
      expect(Object.keys(stored.snapshots).length).toBe(1);
    });

    it("snapshot contains config object and created_at timestamp", () => {
      const config = { tier: "aggressive", maxSol: 2.0 };
      const hash = mod.snapshotConfig(config);

      const stored = JSON.parse(getMockFs()[SNAPSHOTS_FILE]);
      const entry = stored.snapshots[hash];
      expect(entry.config).toEqual(config);
      expect(entry.created_at).toBeDefined();
      expect(new Date(entry.created_at).toISOString()).toBe(entry.created_at);
    });

    it("duplicate configs are not stored twice", () => {
      const config = { a: 1, b: 2 };
      mod.snapshotConfig(config);
      mod.snapshotConfig(config);
      mod.snapshotConfig(config);

      const stored = JSON.parse(getMockFs()[SNAPSHOTS_FILE]);
      expect(Object.keys(stored.snapshots).length).toBe(1);
    });
  });

  describe("getConfigSnapshot() retrieval", () => {
    it("returns full config for valid hash", () => {
      const config = { pool: "SOL-USDC", strategy: "bid_ask" };
      const hash = mod.snapshotConfig(config);

      const snapshot = mod.getConfigSnapshot(hash);
      expect(snapshot).not.toBeNull();
      expect(snapshot.config).toEqual(config);
      expect(snapshot.created_at).toBeDefined();
    });

    it("returns null for unknown hash", () => {
      expect(mod.getConfigSnapshot("deadbeef1234")).toBeNull();
    });
  });

  describe("getCurrentConfigHash()", () => {
    it("returns null when no snapshot exists", () => {
      expect(mod.getCurrentConfigHash()).toBeNull();
    });

    it("returns current cached hash after snapshotConfig is called", () => {
      const hash = mod.snapshotConfig({ a: 1 });
      expect(mod.getCurrentConfigHash()).toBe(hash);
    });

    it("updates after snapshotConfig is called with new config", async () => {
      const h1 = mod.snapshotConfig({ a: 1 });
      expect(mod.getCurrentConfigHash()).toBe(h1);

      // Force a distinct timestamp for the second snapshot (same-ms race fix)
      const snapshotsData = JSON.parse(getMockFs()[SNAPSHOTS_FILE]);
      snapshotsData.snapshots[h1].created_at = new Date(Date.now() - 60000).toISOString();
      seedMockFs({ [SNAPSHOTS_FILE]: JSON.stringify(snapshotsData) });
      vi.resetModules();
      mod = await import("../../config-snapshot.js");

      const h2 = mod.snapshotConfig({ a: 2 });
      expect(h2).not.toBe(h1);
      expect(mod.getCurrentConfigHash()).toBe(h2);
    });
  });
});

describe("state.js config_hash integration", () => {
  let stateMod;
  async function loadStateModule() {
    resetMockFs();
    vi.resetModules();
    stateMod = await import("../../state.js");
  }

  beforeEach(async () => {
    await loadStateModule();
  });

  describe("trackPosition stores config_hash", () => {
    it("stores config_hash when provided", () => {
      stateMod.trackPosition({
        position: "pos_001",
        pool: "pool_abc",
        config_hash: "abc123def456",
      });

      const pos = stateMod.getTrackedPosition("pos_001");
      expect(pos.config_hash).toBe("abc123def456");
    });

    it("defaults config_hash to null when not provided", () => {
      stateMod.trackPosition({
        position: "pos_001",
        pool: "pool_abc",
      });

      const pos = stateMod.getTrackedPosition("pos_001");
      expect(pos.config_hash).toBeNull();
    });

    it("persists config_hash to state.json", () => {
      stateMod.trackPosition({
        position: "pos_001",
        pool: "pool_abc",
        config_hash: "aabbccddeeff",
      });

      const saved = JSON.parse(getMockFs()["./state.json"]);
      expect(saved.positions.pos_001.config_hash).toBe("aabbccddeeff");
    });
  });

  describe("getStateSummary includes config_hash", () => {
    it("includes config_hash for open positions", () => {
      stateMod.trackPosition({
        position: "pos_001",
        pool: "pool_abc",
        config_hash: "112233445566",
      });

      const summary = stateMod.getStateSummary();
      expect(summary.positions.length).toBe(1);
      expect(summary.positions[0].config_hash).toBe("112233445566");
    });

    it("returns null config_hash when not set", () => {
      stateMod.trackPosition({
        position: "pos_001",
        pool: "pool_abc",
      });

      const summary = stateMod.getStateSummary();
      expect(summary.positions[0].config_hash).toBeNull();
    });
  });
});
