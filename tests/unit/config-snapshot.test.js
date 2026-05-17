import { describe, it, expect, beforeEach, vi } from "vitest";
import { setupMockFs, seedMockFs, getMockFs, resetMockFs } from "../helpers/mock-fs.js";

setupMockFs();

vi.mock("../../logger.js", () => ({
  log: vi.fn(),
}));

const SNAPSHOTS_FILE = "/Users/faizal/Sites/games/aiagents/meridian/config-snapshots.json";

// Realistic trading configs for testing
const baseConfig = () => ({
  risk: { maxPositions: 3, maxDeployAmount: 50 },
  management: { stopLossPct: -50, takeProfitPct: 5, trailingTakeProfit: true },
  screening: { minTvl: 10000, minVolume: 500, minHolders: 500 },
  strategy: { strategy: "bid_ask", minBinsBelow: 35, maxBinsBelow: 69 },
  indicators: { enabled: false },
});

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
      const config = baseConfig();
      const h1 = mod.snapshotConfig(config);
      const h2 = mod.snapshotConfig(config);
      expect(h1).toBe(h2);
    });

    it("different config produces different hash", () => {
      const c1 = baseConfig();
      const c2 = baseConfig();
      c2.screening.minTvl = 5000;
      const h1 = mod.snapshotConfig(c1);
      const h2 = mod.snapshotConfig(c2);
      expect(h1).not.toBe(h2);
    });

    it("hash is a 12-char hex string", () => {
      const hash = mod.snapshotConfig(baseConfig());
      expect(hash).toMatch(/^[0-9a-f]{12}$/);
    });
  });

  describe("snapshotConfig() storage", () => {
    it("snapshot is stored in config-snapshots.json", () => {
      mod.snapshotConfig(baseConfig());
      const files = getMockFs();
      expect(files[SNAPSHOTS_FILE]).toBeDefined();

      const stored = JSON.parse(files[SNAPSHOTS_FILE]);
      expect(stored.snapshots).toBeDefined();
      expect(Object.keys(stored.snapshots).length).toBe(1);
    });

    it("snapshot contains config object and created_at timestamp", () => {
      const config = baseConfig();
      const hash = mod.snapshotConfig(config);

      const stored = JSON.parse(getMockFs()[SNAPSHOTS_FILE]);
      const entry = stored.snapshots[hash];
      expect(entry.config.risk).toEqual({ maxPositions: 3, maxDeployAmount: 50 });
      expect(entry.config.management.stopLossPct).toBe(-50);
      expect(entry.config.screening.minTvl).toBe(10000);
      expect(entry.config.strategy.strategy).toBe("bid_ask");
      expect(entry.created_at).toBeDefined();
      expect(new Date(entry.created_at).toISOString()).toBe(entry.created_at);
    });

    it("duplicate configs are not stored twice", () => {
      const config = baseConfig();
      mod.snapshotConfig(config);
      mod.snapshotConfig(config);
      mod.snapshotConfig(config);

      const stored = JSON.parse(getMockFs()[SNAPSHOTS_FILE]);
      expect(Object.keys(stored.snapshots).length).toBe(1);
    });
  });

  describe("getConfigSnapshot() retrieval", () => {
    it("returns full config for valid hash", () => {
      const config = baseConfig();
      const hash = mod.snapshotConfig(config);

      const snapshot = mod.getConfigSnapshot(hash);
      expect(snapshot).not.toBeNull();
      expect(snapshot.config.risk).toEqual({ maxPositions: 3, maxDeployAmount: 50 });
      expect(snapshot.config.management.stopLossPct).toBe(-50);
      expect(snapshot.config.strategy.strategy).toBe("bid_ask");
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
      const hash = mod.snapshotConfig(baseConfig());
      expect(mod.getCurrentConfigHash()).toBe(hash);
    });

    it("updates after snapshotConfig is called with new config", async () => {
      const h1 = mod.snapshotConfig(baseConfig());
      expect(mod.getCurrentConfigHash()).toBe(h1);

      // Force a distinct timestamp for the second snapshot (same-ms race fix)
      const snapshotsData = JSON.parse(getMockFs()[SNAPSHOTS_FILE]);
      snapshotsData.snapshots[h1].created_at = new Date(Date.now() - 60000).toISOString();
      seedMockFs({ [SNAPSHOTS_FILE]: JSON.stringify(snapshotsData) });
      vi.resetModules();
      mod = await import("../../config-snapshot.js");

      const c2 = baseConfig();
      c2.strategy.strategy = "curve";
      const h2 = mod.snapshotConfig(c2);
      expect(h2).not.toBe(h1);
      expect(mod.getCurrentConfigHash()).toBe(h2);
    });
  });

  describe("strips non-trading sections", () => {
    it("excludes schedule, llm, tokens, hiveMind, api, jupiter, darwin", () => {
      const config = {
        ...baseConfig(),
        schedule: { managementIntervalMin: 10 },
        llm: { temperature: 0.5, model: "test" },
        tokens: { SOL: "abc" },
        hiveMind: { url: "http://test", apiKey: "secret" },
        api: { url: "http://api", publicApiKey: "pub" },
        jupiter: { apiKey: "jup" },
        darwin: { enabled: true },
      };
      const hash = mod.snapshotConfig(config);
      const snapshot = mod.getConfigSnapshot(hash);

      expect(snapshot.config.schedule).toBeUndefined();
      expect(snapshot.config.llm).toBeUndefined();
      expect(snapshot.config.tokens).toBeUndefined();
      expect(snapshot.config.hiveMind).toBeUndefined();
      expect(snapshot.config.api).toBeUndefined();
      expect(snapshot.config.jupiter).toBeUndefined();
      expect(snapshot.config.darwin).toBeUndefined();
      expect(snapshot.config.risk).toBeDefined();
      expect(snapshot.config.screening).toBeDefined();
      expect(snapshot.config.management).toBeDefined();
      expect(snapshot.config.strategy).toBeDefined();
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
