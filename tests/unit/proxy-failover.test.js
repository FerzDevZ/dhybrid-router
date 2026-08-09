import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the whole proxyHealth module — proxyFetch lazy-imports it, so this is
// the reliable seam for deterministic failover tests.
const healthMock = vi.hoisted(() => ({
  getPoolProxyOptions: vi.fn(),
  reportProxySuccess: vi.fn(),
  reportProxyFailure: vi.fn(),
}));

vi.mock("../../src/lib/network/proxyHealth.js", () => healthMock);

// Single persistent fetch mock — proxyFetch captures originalFetch at module
// init, so the same fn must be installed BEFORE importing proxyFetch (top-level).
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { proxyAwareFetch } = await import("../../open-sse/utils/proxyFetch.js");

beforeEach(() => {
  vi.clearAllMocks();
  // report* return promises — proxyFetch calls .catch() on them
  healthMock.reportProxySuccess.mockResolvedValue();
  healthMock.reportProxyFailure.mockResolvedValue();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("proxy failover (cross-pool)", () => {
  it("retries the next healthy pool when the picked pool fails", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    healthMock.getPoolProxyOptions.mockResolvedValue({
      id: "pool-b",
      connectionProxyUrl: "http://pool-b:8080",
      vercelRelayUrl: "",
    });

    const res = await proxyAwareFetch("https://example.com/v1/chat", { method: "POST" }, {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://pool-a:8080",
      connectionProxyPoolId: "pool-a",
      connectionProxyPoolIds: ["pool-a", "pool-b"],
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // failover asked for pool-b (excludes already-tried pool-a)
    expect(healthMock.getPoolProxyOptions).toHaveBeenCalledWith(["pool-b"]);
    // failure was reported for pool-a, success for pool-b
    expect(healthMock.reportProxyFailure).toHaveBeenCalledWith("pool-a", expect.any(String));
    expect(healthMock.reportProxySuccess).toHaveBeenCalledWith("pool-b", expect.any(Number));
  });

  it("falls back to direct when all pools fail (non-strict)", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(new Response("direct ok", { status: 200 }));
    healthMock.getPoolProxyOptions.mockResolvedValue(null);

    const res = await proxyAwareFetch("https://example.com/v1/chat", { method: "POST" }, {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://pool-a:8080",
      connectionProxyPoolId: "pool-a",
      connectionProxyPoolIds: ["pool-a"],
    });

    // proxy attempt failed → no healthy alt → direct fetch (2nd call) succeeds
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(healthMock.reportProxyFailure).toHaveBeenCalledWith("pool-a", expect.any(String));
  });

  it("throws when strictProxy=true and the pool is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    healthMock.getPoolProxyOptions.mockResolvedValue(null);

    await expect(
      proxyAwareFetch("https://example.com/v1/chat", {}, {
        connectionProxyEnabled: true,
        connectionProxyUrl: "http://pool-a:8080",
        connectionProxyPoolId: "pool-a",
        connectionProxyPoolIds: ["pool-a"],
        strictProxy: true,
      })
    ).rejects.toThrow("strictProxy=true");
  });

  it("does not fail over when no pool list is provided", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const res = await proxyAwareFetch("https://example.com", {}, {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://pool-a:8080",
      connectionProxyPoolId: "pool-a",
    });

    // no poolIds → first failure falls back to direct (2nd fetch)
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(healthMock.getPoolProxyOptions).not.toHaveBeenCalled();
  });
});
