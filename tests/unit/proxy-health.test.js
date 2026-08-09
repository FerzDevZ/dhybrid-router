import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the repo layer so health logic is tested in isolation (no real DB).
const repoMock = vi.hoisted(() => ({
  getProxyPoolById: vi.fn(),
  getProxyPools: vi.fn(),
  updateProxyPool: vi.fn(),
}));

vi.mock("../../src/lib/db/repos/proxyPoolsRepo.js", () => repoMock);

const health = await import("../../src/lib/network/proxyHealth.js");

describe("proxy health: circuit breaker + metrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detects pool inside/outside cooldown window", () => {
    const now = Date.now();
    expect(health.isPoolInCooldown({ cooldownUntil: new Date(now + 5000).toISOString() }, now)).toBe(true);
    expect(health.isPoolInCooldown({ cooldownUntil: new Date(now - 1000).toISOString() }, now)).toBe(false);
    expect(health.isPoolInCooldown({}, now)).toBe(false);
    expect(health.getPoolCooldownMs({ cooldownUntil: new Date(now + 3000).toISOString() }, now)).toBe(3000);
    expect(health.getPoolCooldownMs({}, now)).toBe(0);
  });

  it("reportProxySuccess records latency and resets failure state", async () => {
    repoMock.getProxyPoolById.mockResolvedValue({
      id: "p1",
      successCount: 4,
      requestCount: 5,
      avgLatencyMs: 100,
      latencySamples: 4,
      consecutiveFailures: 3,
      cooldownUntil: new Date(Date.now() + 60000).toISOString(),
    });
    await health.reportProxySuccess("p1", 200);
    const update = repoMock.updateProxyPool.mock.calls[0];
    expect(update[0]).toBe("p1");
    expect(update[1]).toMatchObject({
      successCount: 5,
      requestCount: 6,
      avgLatencyMs: 120, // (100*4 + 200) / 5
      consecutiveFailures: 0,
      cooldownUntil: null,
      testStatus: "active",
    });
  });

  it("reportProxyFailure engages exponential cooldown after threshold", async () => {
    repoMock.getProxyPoolById.mockResolvedValue({ id: "p1", consecutiveFailures: 1 });
    await health.reportProxyFailure("p1", "ECONNREFUSED");
    const update = repoMock.updateProxyPool.mock.calls[0][1];
    expect(update.consecutiveFailures).toBe(2);
    expect(update.cooldownUntil).toBeTruthy(); // threshold reached → cooldown set
    expect(update.failCount).toBe(1);
    expect(update.testStatus).toBe("error");
  });

  it("single failure before threshold does not engage cooldown", async () => {
    repoMock.getProxyPoolById.mockResolvedValue({ id: "p1", consecutiveFailures: 0 });
    await health.reportProxyFailure("p1", "boom");
    const update = repoMock.updateProxyPool.mock.calls[0][1];
    expect(update.consecutiveFailures).toBe(1);
    expect(update.cooldownUntil).toBeNull();
  });

  it("auto-test tick marks dead pool in cooldown and revives healthy one", async () => {
    repoMock.getProxyPools.mockResolvedValue([
      { id: "dead", isActive: true, consecutiveFailures: 1, successCount: 0, requestCount: 0, failCount: 0 },
      { id: "alive", isActive: true, consecutiveFailures: 5, successCount: 1, requestCount: 1, failCount: 2, cooldownUntil: "x", latencySamples: 0, latencyHistory: [] },
    ]);
    const connectivityTest = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "timed out", status: 500, elapsedMs: 100 })
      .mockResolvedValueOnce({ ok: true, status: 200, elapsedMs: 50 });
    await health.runProxyHealthTick({ connectivityTest });
    expect(repoMock.updateProxyPool).toHaveBeenCalledTimes(2);
    const [deadId, deadUpdate] = repoMock.updateProxyPool.mock.calls[0];
    expect(deadId).toBe("dead");
    expect(deadUpdate.testStatus).toBe("error");
    expect(deadUpdate.cooldownUntil).toBeTruthy();
    const [aliveId, aliveUpdate] = repoMock.updateProxyPool.mock.calls[1];
    expect(aliveId).toBe("alive");
    expect(aliveUpdate.testStatus).toBe("active");
    expect(aliveUpdate.cooldownUntil).toBeNull();
    expect(aliveUpdate.consecutiveFailures).toBe(0);
    // latencyHistory should be updated on successful test
    expect(aliveUpdate.latencyHistory).toEqual([50]);
  });

  it("getPoolProxyOptions picks a healthy pool and skips cooldown ones", async () => {
    repoMock.getProxyPools.mockResolvedValue([
      { id: "hot", proxyUrl: "http://hot:1", type: "http", isActive: true, cooldownUntil: new Date(Date.now() + 60000).toISOString() },
      { id: "ok", proxyUrl: "http://ok:1", type: "http", isActive: true },
      { id: "relay", proxyUrl: "https://relay.example", type: "vercel", isActive: true },
    ]);
    const picked = await health.getPoolProxyOptions(["hot", "ok", "relay"]);
    expect(picked.id).toBe("ok");
    expect(picked.connectionProxyUrl).toBe("http://ok:1");
    expect(picked.vercelRelayUrl).toBe("");
  });

  it("getPoolProxyOptions picks a relay pool and maps url to relay field", async () => {
    repoMock.getProxyPools.mockResolvedValue([
      { id: "relay", proxyUrl: "https://relay.example", type: "cloudflare", isActive: true },
    ]);
    const picked = await health.getPoolProxyOptions(["relay"]);
    expect(picked.connectionProxyUrl).toBe("");
    expect(picked.vercelRelayUrl).toBe("https://relay.example");
  });

  it("getPoolProxyOptions returns null when all candidates are cooling down", async () => {
    repoMock.getProxyPools.mockResolvedValue([
      { id: "hot", proxyUrl: "http://hot:1", type: "http", isActive: true, cooldownUntil: new Date(Date.now() + 60000).toISOString() },
    ]);
    expect(await health.getPoolProxyOptions(["hot"])).toBeNull();
    expect(await health.getPoolProxyOptions([])).toBeNull();
  });

  it("metrics failures never throw (fail-open)", async () => {
    repoMock.getProxyPoolById.mockRejectedValue(new Error("db down"));
    await expect(health.reportProxySuccess("p1", 10)).resolves.toBeUndefined();
    await expect(health.reportProxyFailure("p1", "x")).resolves.toBeUndefined();
  });
});
