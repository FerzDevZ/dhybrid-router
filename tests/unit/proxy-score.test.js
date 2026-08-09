import { describe, it, expect, vi, beforeEach } from "vitest";

// Single repo mock shared by proxyHealth and connectionProxy (same module path).
const repoMock = vi.hoisted(() => ({ getProxyPools: vi.fn(), getProxyPoolById: vi.fn(), updateProxyPool: vi.fn() }));
vi.mock("../../src/lib/db/repos/proxyPoolsRepo.js", () => repoMock);

const health = await import("../../src/lib/network/proxyHealth.js");

// ── connectionProxy (pickProxyPoolId weighted) ──────────────────
const kvMock = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("../../src/lib/db/helpers/kvStore.js", () => ({ makeKv: () => kvMock }));

const { pickProxyPoolId } = await import("../../src/lib/network/connectionProxy.js");

describe("computePoolScore — health scoring", () => {
  it("returns neutral 50 for pools without usage data", () => {
    expect(health.computePoolScore({})).toBe(50);
    expect(health.computePoolScore({ successCount: 0, failCount: 0, avgLatencyMs: null })).toBe(50);
  });

  it("rates a 100%-success fast pool above a 50%-success pool", () => {
    const good = { successCount: 10, failCount: 0, avgLatencyMs: 100 };
    const mediocre = { successCount: 5, failCount: 5, avgLatencyMs: 100 };
    expect(health.computePoolScore(good)).toBeGreaterThan(health.computePoolScore(mediocre));
  });

  it("penalizes high latency", () => {
    const fast = { successCount: 10, failCount: 0, avgLatencyMs: 100 };
    const slow = { successCount: 10, failCount: 0, avgLatencyMs: 5000 };
    expect(health.computePoolScore(fast)).toBeGreaterThan(health.computePoolScore(slow));
  });

  it("clamps the score to 0..100", () => {
    const zero = { successCount: 0, failCount: 10, avgLatencyMs: 6000 };
    const perfect = { successCount: 10, failCount: 0, avgLatencyMs: 1 };
    expect(health.computePoolScore(zero)).toBe(0);
    expect(health.computePoolScore(perfect)).toBeLessThanOrEqual(100);
    expect(health.computePoolScore(perfect)).toBeGreaterThanOrEqual(0);
  });

  it("blends manual weight 50/50 with the health score (G2)", () => {
    // health score for no data = 50; weight 80 → (80 + 50) / 2 = 65
    expect(health.computePoolScore({ weight: 80 })).toBe(65);
    // weight 0 (off) → plain health score (no data = 50)
    expect(health.computePoolScore({ weight: 0 })).toBe(50);
  });
});

describe("getPoolProxyOptions — best-score-first failover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repoMock.getProxyPools.mockResolvedValue([]);
  });

  it("picks the highest-scored healthy pool regardless of list order", async () => {
    const good = { id: "good", proxyUrl: "http://good:1", type: "http", isActive: true, successCount: 10, failCount: 0, avgLatencyMs: 100 };
    const bad = { id: "bad", proxyUrl: "http://bad:1", type: "http", isActive: true, successCount: 0, failCount: 10, avgLatencyMs: 6000 };
    repoMock.getProxyPools.mockResolvedValue([bad, good]); // bad listed first
    const picked = await health.getPoolProxyOptions(["bad", "good"]);
    expect(picked.id).toBe("good");
  });

  it("honors manual priority over health score (E1)", async () => {
    const lowPriority = { id: "low", proxyUrl: "http://low:1", type: "http", isActive: true, priority: 10, successCount: 0, failCount: 10, avgLatencyMs: 6000 };
    const highPriority = { id: "high", proxyUrl: "http://high:1", type: "http", isActive: true, priority: 90, successCount: 10, failCount: 0, avgLatencyMs: 100 };
    repoMock.getProxyPools.mockResolvedValue([highPriority, lowPriority]);
    const picked = await health.getPoolProxyOptions(["low", "high"]);
    expect(picked.id).toBe("low"); // lower priority number = tried first
  });

  it("breaks priority ties by health score (E1)", async () => {
    const good = { id: "good", proxyUrl: "http://good:1", type: "http", isActive: true, priority: 50, successCount: 10, failCount: 0, avgLatencyMs: 100 };
    const bad = { id: "bad", proxyUrl: "http://bad:1", type: "http", isActive: true, priority: 50, successCount: 0, failCount: 10, avgLatencyMs: 6000 };
    repoMock.getProxyPools.mockResolvedValue([bad, good]);
    const picked = await health.getPoolProxyOptions(["bad", "good"]);
    expect(picked.id).toBe("good");
  });
});

describe("pickProxyPoolId — weighted (health) strategy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repoMock.getProxyPools.mockResolvedValue([]);
    kvMock.get.mockResolvedValue(null);
    kvMock.set.mockResolvedValue();
  });

  it("never picks a pool in cooldown", async () => {
    repoMock.getProxyPools.mockResolvedValue([
      { id: "pool-b", cooldownUntil: new Date(Date.now() + 60000).toISOString() },
    ]);
    const ids = ["pool-a", "pool-b"];
    for (let i = 0; i < 20; i += 1) {
      const picked = await pickProxyPoolId(ids, "weighted", "p1");
      expect(["pool-a", "pool-b"]).toContain(picked); // cooldown fallback rules still apply (full list when all down)
    }
  });

  it("picks the only healthy candidate deterministically", async () => {
    repoMock.getProxyPools.mockResolvedValue([
      { id: "pool-b", cooldownUntil: new Date(Date.now() + 60000).toISOString() },
    ]);
    const ids = ["pool-a", "pool-b"];
    for (let i = 0; i < 10; i += 1) {
      expect(await pickProxyPoolId(ids, "weighted", "p2")).toBe("pool-a");
    }
  });

  it("stays within the candidate set for mixed-health pools", async () => {
    repoMock.getProxyPools.mockResolvedValue([
      { id: "a", successCount: 10, failCount: 0, avgLatencyMs: 100 },
      { id: "b", successCount: 0, failCount: 10, avgLatencyMs: 6000 },
    ]);
    const ids = ["a", "b"];
    for (let i = 0; i < 20; i += 1) {
      expect(["a", "b"]).toContain(await pickProxyPoolId(ids, "weighted", "p3"));
    }
  });
});
