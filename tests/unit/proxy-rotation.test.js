import { describe, it, expect, vi, beforeEach } from "vitest";

const kvMock = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock("../../src/lib/db/helpers/kvStore.js", () => ({ makeKv: () => kvMock }));

const repoMock = vi.hoisted(() => ({ getProxyPools: vi.fn() }));
vi.mock("../../src/lib/db/repos/proxyPoolsRepo.js", () => repoMock);

const { pickProxyPoolId } = await import("../../src/lib/network/connectionProxy.js");

describe("pickProxyPoolId — persistent round-robin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repoMock.getProxyPools.mockResolvedValue([]); // no cooldown state
    kvMock.set.mockResolvedValue();
  });

  it("cycles through pools sequentially", async () => {
    kvMock.get.mockResolvedValue(null); // no persisted cursor yet
    const ids = ["pool-a", "pool-b", "pool-c"];

    expect(await pickProxyPoolId(ids, "round-robin", "p1")).toBe("pool-a");
    expect(await pickProxyPoolId(ids, "round-robin", "p1")).toBe("pool-b");
    expect(await pickProxyPoolId(ids, "round-robin", "p1")).toBe("pool-c");
    expect(await pickProxyPoolId(ids, "round-robin", "p1")).toBe("pool-a");
  });

  it("restores the cursor from kv after a restart", async () => {
    kvMock.get.mockResolvedValue({ index: 0 }); // persisted mid-cycle → next pick = index 1
    const ids = ["pool-a", "pool-b", "pool-c"];

    expect(await pickProxyPoolId(ids, "round-robin", "p2")).toBe("pool-b");
  });

  it("persists the cursor to kv (throttled)", async () => {
    kvMock.get.mockResolvedValue(null);
    const ids = ["pool-a", "pool-b"];

    await pickProxyPoolId(ids, "round-robin", "p3");
    expect(kvMock.set).toHaveBeenCalledWith("p3", { index: 0 });
  });

  it("skips pools currently in cooldown", async () => {
    kvMock.get.mockResolvedValue(null);
    repoMock.getProxyPools.mockResolvedValue([
      { id: "pool-b", cooldownUntil: new Date(Date.now() + 60000).toISOString() },
    ]);
    const ids = ["pool-a", "pool-b"];

    // only pool-a is healthy → always picks pool-a
    expect(await pickProxyPoolId(ids, "round-robin", "p4")).toBe("pool-a");
    expect(await pickProxyPoolId(ids, "round-robin", "p4")).toBe("pool-a");
  });

  it("falls back to the full list when every pool is in cooldown", async () => {
    kvMock.get.mockResolvedValue(null);
    repoMock.getProxyPools.mockResolvedValue([
      { id: "pool-a", cooldownUntil: new Date(Date.now() + 60000).toISOString() },
      { id: "pool-b", cooldownUntil: new Date(Date.now() + 60000).toISOString() },
    ]);
    const ids = ["pool-a", "pool-b"];

    expect(await pickProxyPoolId(ids, "round-robin", "p5")).toBe("pool-a");
  });
});
