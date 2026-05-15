import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { setupMockFs, seedMockFs, resetMockFs, readMockFile } from "../helpers/mock-fs.js";

setupMockFs();

vi.mock("dotenv/config", () => ({}));
vi.mock("../../logger.js", () => ({ log: vi.fn() }));

let poolMemory;
async function loadModule() {
  resetMockFs();
  vi.resetModules();
  // Re-setup mocks after resetModules
  vi.mock("dotenv/config", () => ({}));
  vi.mock("../../logger.js", () => ({ log: vi.fn() }));
  setupMockFs();
  poolMemory = await import("../../pool-memory.js");
}

const POOL_ADDR = "J9sHieTestPool111111111111111111111111111";
const POOL_ADDR2 = "K8tKifTestPool222222222222222222222222222";
const BASE_MINT = "DustMint1111111111111111111111111111111";
const COOLDOWN_MINUTES = 30;

function seedPoolEntry(poolAddr, overrides = {}) {
  const entry = {
    name: "TestPool",
    base_mint: null,
    deploys: [],
    total_deploys: 0,
    avg_pnl_pct: 0,
    win_rate: 0,
    adjusted_win_rate: 0,
    adjusted_win_rate_sample_count: 0,
    last_deployed_at: null,
    last_outcome: null,
    notes: [],
    ...overrides,
  };
  const db = { [poolAddr]: entry };
  seedMockFs({ "./pool-memory.json": JSON.stringify(db) });
}

describe("rejection cooldown", () => {
  beforeEach(async () => {
    await loadModule();
  });

  describe("recordScreeningRejection", () => {
    it("sets rejection_cooldown_until on a pool entry", () => {
      seedPoolEntry(POOL_ADDR);
      const before = Date.now();

      poolMemory.recordScreeningRejection(POOL_ADDR, BASE_MINT, "bad metrics", COOLDOWN_MINUTES);

      const written = JSON.parse(readMockFile("./pool-memory.json"));
      const entry = written[POOL_ADDR];
      expect(entry.rejection_cooldown_until).toBeDefined();
      const cooldownTime = new Date(entry.rejection_cooldown_until).getTime();
      expect(cooldownTime).toBeGreaterThan(before);
      expect(cooldownTime).toBeLessThanOrEqual(before + COOLDOWN_MINUTES * 60 * 1000 + 1000);
    });

    it("sets rejection_cooldown_reason from the reason parameter", () => {
      seedPoolEntry(POOL_ADDR);
      poolMemory.recordScreeningRejection(POOL_ADDR, BASE_MINT, "insufficient TVL", COOLDOWN_MINUTES);

      const written = JSON.parse(readMockFile("./pool-memory.json"));
      expect(written[POOL_ADDR].rejection_cooldown_reason).toBe("insufficient TVL");
    });

    it("creates a new pool entry if it doesn't exist", () => {
      // No seed — empty db
      poolMemory.recordScreeningRejection(POOL_ADDR, BASE_MINT, "first rejection", COOLDOWN_MINUTES);

      const written = JSON.parse(readMockFile("./pool-memory.json"));
      const entry = written[POOL_ADDR];
      expect(entry).toBeDefined();
      expect(entry.name).toBe(POOL_ADDR.slice(0, 8));
      expect(entry.rejection_cooldown_until).toBeDefined();
      expect(entry.deploys).toEqual([]);
    });

    it("sets base_mint when entry.base_mint is null", () => {
      seedPoolEntry(POOL_ADDR, { base_mint: null });

      poolMemory.recordScreeningRejection(POOL_ADDR, BASE_MINT, "test", COOLDOWN_MINUTES);

      const written = JSON.parse(readMockFile("./pool-memory.json"));
      expect(written[POOL_ADDR].base_mint).toBe(BASE_MINT);
    });

    it("does not overwrite base_mint when it is already set", () => {
      const existingMint = "ExistingMint111111111111111111111111";
      seedPoolEntry(POOL_ADDR, { base_mint: existingMint });

      poolMemory.recordScreeningRejection(POOL_ADDR, BASE_MINT, "test", COOLDOWN_MINUTES);

      const written = JSON.parse(readMockFile("./pool-memory.json"));
      expect(written[POOL_ADDR].base_mint).toBe(existingMint);
    });

    it("is a no-op for empty pool address", () => {
      poolMemory.recordScreeningRejection("", BASE_MINT, "test", COOLDOWN_MINUTES);
      poolMemory.recordScreeningRejection(null, BASE_MINT, "test", COOLDOWN_MINUTES);
      // Should not crash and no file written (empty db)
      // No assertion needed — just checking it doesn't throw
    });
  });

  describe("isPoolOnCooldown", () => {
    it("returns true when rejection cooldown is active", () => {
      seedPoolEntry(POOL_ADDR);
      poolMemory.recordScreeningRejection(POOL_ADDR, BASE_MINT, "test", COOLDOWN_MINUTES);

      expect(poolMemory.isPoolOnCooldown(POOL_ADDR)).toBe(true);
    });

    it("returns false when rejection cooldown has expired", () => {
      // Seed with a cooldown that expired 1 minute ago
      const expiredCooldown = new Date(Date.now() - 60 * 1000).toISOString();
      seedPoolEntry(POOL_ADDR, {
        rejection_cooldown_until: expiredCooldown,
        rejection_cooldown_reason: "expired",
      });

      expect(poolMemory.isPoolOnCooldown(POOL_ADDR)).toBe(false);
    });

    it("returns false for unknown pool", () => {
      seedPoolEntry(POOL_ADDR); // seed some data but query a different pool
      expect(poolMemory.isPoolOnCooldown(POOL_ADDR2)).toBe(false);
    });

    it("returns false for null", () => {
      seedPoolEntry(POOL_ADDR);
      expect(poolMemory.isPoolOnCooldown(null)).toBe(false);
    });

    it("returns false for undefined", () => {
      seedPoolEntry(POOL_ADDR);
      expect(poolMemory.isPoolOnCooldown(undefined)).toBe(false);
    });

    it("returns true when regular cooldown_until is active", () => {
      const futureCooldown = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      seedPoolEntry(POOL_ADDR, {
        cooldown_until: futureCooldown,
        cooldown_reason: "low yield",
      });

      expect(poolMemory.isPoolOnCooldown(POOL_ADDR)).toBe(true);
    });

    it("returns true when either cooldown is active (rejection)", () => {
      // Regular cooldown expired, rejection still active
      const expiredCooldown = new Date(Date.now() - 60 * 1000).toISOString();
      seedPoolEntry(POOL_ADDR, {
        cooldown_until: expiredCooldown,
        cooldown_reason: "old",
        rejection_cooldown_until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        rejection_cooldown_reason: "active",
      });

      expect(poolMemory.isPoolOnCooldown(POOL_ADDR)).toBe(true);
    });
  });

  describe("clearRejectionCooldown", () => {
    it("removes rejection cooldown fields", () => {
      seedPoolEntry(POOL_ADDR);
      poolMemory.recordScreeningRejection(POOL_ADDR, BASE_MINT, "test", COOLDOWN_MINUTES);

      poolMemory.clearRejectionCooldown(POOL_ADDR);

      const written = JSON.parse(readMockFile("./pool-memory.json"));
      const entry = written[POOL_ADDR];
      expect(entry.rejection_cooldown_until).toBeUndefined();
      expect(entry.rejection_cooldown_reason).toBeUndefined();
    });

    it("returns false for isPoolOnCooldown after clearing", () => {
      seedPoolEntry(POOL_ADDR);
      poolMemory.recordScreeningRejection(POOL_ADDR, BASE_MINT, "test", COOLDOWN_MINUTES);
      expect(poolMemory.isPoolOnCooldown(POOL_ADDR)).toBe(true);

      poolMemory.clearRejectionCooldown(POOL_ADDR);
      expect(poolMemory.isPoolOnCooldown(POOL_ADDR)).toBe(false);
    });

    it("is a no-op for unknown pool", () => {
      seedPoolEntry(POOL_ADDR);
      poolMemory.clearRejectionCooldown("UNKNOWN1111111111111111111111111111");
      // Should not throw
    });

    it("is a no-op for null", () => {
      poolMemory.clearRejectionCooldown(null);
      // Should not throw
    });

    it("does not clear regular cooldown_until", () => {
      const futureCooldown = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      seedPoolEntry(POOL_ADDR, {
        cooldown_until: futureCooldown,
        cooldown_reason: "low yield",
      });
      poolMemory.recordScreeningRejection(POOL_ADDR, BASE_MINT, "rejection", COOLDOWN_MINUTES);

      poolMemory.clearRejectionCooldown(POOL_ADDR);

      const written = JSON.parse(readMockFile("./pool-memory.json"));
      expect(written[POOL_ADDR].cooldown_until).toBe(futureCooldown);
      expect(written[POOL_ADDR].cooldown_reason).toBe("low yield");
      // Rejection fields removed
      expect(written[POOL_ADDR].rejection_cooldown_until).toBeUndefined();
    });
  });
});
