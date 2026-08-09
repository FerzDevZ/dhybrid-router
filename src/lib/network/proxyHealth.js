// Proxy pool health monitor: circuit breaker, per-pool metrics, and
// background auto-test scheduler.
// Fail-open everywhere — DB errors never break live traffic.
// Imports are relative (no "@/" alias) so this module also runs from
// custom-server.js under plain Node ESM (same pattern as backgroundTokenRefresh).

const COOLDOWN_BASE_MS = 30 * 1000;
const COOLDOWN_MAX_MS = 10 * 60 * 1000;
const COOLDOWN_THRESHOLD = 2; // consecutive failures before cooldown engages
const TEST_TIMEOUT_MS = 10 * 1000;
const MONITOR_INTERVAL_MS = 60 * 1000;
const INITIAL_DELAY_MS = 15 * 1000;
const MAX_LATENCY_SAMPLES = 50;

let started = false;
let intervalHandle = null;
let initialTimeoutHandle = null;
let tickRunning = false;

function isTruthyEnv(value) {
  if (value == null || value === "") return false;
  const v = String(value).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function isNonServerRuntime() {
  if (typeof window !== "undefined") return true;
  const phase = process.env.NEXT_PHASE || "";
  if (
    phase === "phase-production-build" ||
    phase === "phase-export" ||
    phase === "phase-static"
  ) {
    return true;
  }
  if (process.env.NEXT_RUNTIME === "edge") return true;
  return false;
}

function parseMs(value) {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

function nextCooldownMs(failures) {
  // Exponential backoff: 30s, 1m, 2m, 4m ... capped at 10m
  const exp = Math.min(Math.max(failures - COOLDOWN_THRESHOLD, 0), 6);
  return Math.min(COOLDOWN_BASE_MS * 2 ** exp, COOLDOWN_MAX_MS);
}

function pushAvgLatency(prevAvg, samples, latencyMs) {
  const n = Math.min(samples || 0, MAX_LATENCY_SAMPLES);
  return Math.round(n > 0 ? (prevAvg * n + latencyMs) / (n + 1) : latencyMs);
}

function isRelayPool(pool) {
  return pool?.type === "vercel" || pool?.type === "cloudflare" || pool?.type === "deno";
}

/**
 * Health score 0-100 for routing/failover ordering.
 * Success rate is the main weight; latency penalizes slow pools (5s → 0).
 * Pools without usage data get a neutral 50.
 * Manual weight (0-100, 0 = off) blends 50/50 with the health score.
 */
export function computePoolScore(pool) {
  const total = (pool?.successCount || 0) + (pool?.failCount || 0);
  const successRate = total > 0 ? (pool?.successCount || 0) / total : null;
  let score = 50;
  if (successRate != null) score += (successRate - 0.5) * 100; // -50..+50
  const latency = pool?.avgLatencyMs;
  if (latency != null && Number.isFinite(latency) && latency > 0) {
    const latScore = Math.max(0, 1 - latency / 5000); // 5s → 0
    score = score * 0.7 + latScore * 100 * 0.3;
  }
  const weight = Number(pool?.weight) || 0;
  if (weight > 0) score = (weight + score) / 2;
  return Math.round(Math.min(100, Math.max(0, score)));
}

async function loadRepo() {
  return import("../../lib/db/repos/proxyPoolsRepo.js");
}

let loggerPromise = null;
function getLogger() {
  if (!loggerPromise) {
    loggerPromise = import("../../sse/utils/logger.js").catch((e) => {
      loggerPromise = null; // allow retry
      console.warn("[ProxyHealth] logger import failed (log disabled):", e?.message ?? e);
      return null;
    });
  }
  return loggerPromise;
}

// Read lazily so env changes at server start (not module load) take effect.
function getWebhookUrl() {
  return isNonServerRuntime() ? "" : process.env.PROXY_WEBHOOK_URL || "";
}

/**
 * Optional webhook notification (F3) — fail-open, 5s timeout.
 * Payload: { event: "pool.cooldown", poolId, name, failures, cooldownMs, error }
 */
async function sendWebhook(payload) {
  const webhookUrl = getWebhookUrl();
  if (!webhookUrl) return;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.warn("[ProxyHealth] webhook failed (swallowed):", e?.message ?? e);
  }
}

/** Log + webhook when a pool just entered cooldown. */
async function notifyPoolCooldown(pool, cooldownMs, errorText) {
  const message = `Pool ${pool.name || pool.id} entered cooldown (${Math.round(cooldownMs / 1000)}s) | ${String(errorText || "").slice(0, 120)}`;
  const log = await getLogger();
  log?.warn?.("PROXY", message);
  await sendWebhook({
    event: "pool.cooldown",
    poolId: pool.id,
    name: pool.name,
    failures: pool.consecutiveFailures || 0,
    cooldownMs: Math.round(cooldownMs),
    error: String(errorText || "").slice(0, 300),
    at: new Date().toISOString(),
  });
}

/**
 * Detach a dead pool from all connections that bind to it.
 * Guarded by DISABLE_PROXY_AUTO_UNBIND (global) and pool.autoUnbind (per pool).
 * Fail-open: any error leaves bindings untouched.
 */
async function autoUnbindPool(poolId, poolName) {
  if (isTruthyEnv(process.env.DISABLE_PROXY_AUTO_UNBIND)) return;
  try {
    const { getProviderConnections, updateProviderConnection } = await import("../../models/index.js");
    const connections = await getProviderConnections();
    const bound = connections.filter((c) => c?.providerSpecificData?.proxyPoolId === poolId);
    if (bound.length === 0) return;
    let done = 0;
    await Promise.allSettled(
      bound.map(async (conn) => {
        try {
          const psd = { ...(conn.providerSpecificData || {}) };
          delete psd.proxyPoolId;
          await updateProviderConnection(conn.id, { providerSpecificData: psd });
          done += 1;
        } catch (e) {
          console.warn("[ProxyHealth] auto-unbind failed (swallowed):", conn.id, e?.message ?? e);
        }
      })
    );
    const log = await getLogger();
    log?.warn?.("PROXY", `Pool ${poolName || poolId} entered cooldown — auto-unbound from ${done} connection(s)`);
  } catch (e) {
    console.warn("[ProxyHealth] autoUnbindPool failed (swallowed):", e?.message ?? e);
  }
}

/**
 * True if the pool is inside its circuit-breaker cooldown window.
 */
export function isPoolInCooldown(pool, nowMs = Date.now()) {
  return parseMs(pool?.cooldownUntil) > nowMs;
}

export function getPoolCooldownMs(pool, nowMs = Date.now()) {
  return Math.max(0, parseMs(pool?.cooldownUntil) - nowMs);
}

/**
 * Record a failed request through a pool. Increments failures + failCount,
 * engages exponential-backoff cooldown after COOLDOWN_THRESHOLD failures.
 */
export async function reportProxyFailure(poolId, errorText) {
  if (!poolId) return;
  try {
    const { getProxyPoolById, updateProxyPool } = await loadRepo();
    const pool = await getProxyPoolById(poolId);
    if (!pool) return;
    const failures = (pool.consecutiveFailures || 0) + 1;
    const cooldownMs = failures >= COOLDOWN_THRESHOLD ? nextCooldownMs(failures) : 0;
    await updateProxyPool(poolId, {
      consecutiveFailures: failures,
      cooldownUntil: cooldownMs ? new Date(Date.now() + cooldownMs).toISOString() : null,
      failCount: (pool.failCount || 0) + 1,
      requestCount: (pool.requestCount || 0) + 1,
      testStatus: "error",
      lastError: String(errorText || "Proxy request failed").slice(0, 300),
      lastErrorAt: new Date().toISOString(),
    });
    if (failures === COOLDOWN_THRESHOLD) {
      await notifyPoolCooldown({ ...pool, consecutiveFailures: failures }, cooldownMs, errorText);
      // Same auto-unbind semantics as the tick path: a pool that first crosses
      // the threshold via live traffic must be detached too, or it never is.
      if (pool.autoUnbind !== false) {
        await autoUnbindPool(pool.id, pool.name);
      }
    }
  } catch (e) {
    console.warn("[ProxyHealth] reportProxyFailure failed (swallowed):", e?.message ?? e);
  }
}

/**
 * Record a successful request through a pool. Resets failure state and
 * updates latency metrics.
 */
export async function reportProxySuccess(poolId, latencyMs) {
  if (!poolId) return;
  try {
    const { getProxyPoolById, updateProxyPool } = await loadRepo();
    const pool = await getProxyPoolById(poolId);
    if (!pool) return;
    const latency = Number.isFinite(latencyMs) && latencyMs >= 0 ? Math.round(latencyMs) : null;
    const successCount = (pool.successCount || 0) + 1;
    const requestCount = (pool.requestCount || 0) + 1;
    const latencyHistory = latency != null ? [...(pool.latencyHistory || []).slice(-99), latency] : (pool.latencyHistory || []);
    await updateProxyPool(poolId, {
      successCount,
      requestCount,
      avgLatencyMs: latency != null ? pushAvgLatency(pool.avgLatencyMs, pool.latencySamples, latency) : pool.avgLatencyMs,
      lastLatencyMs: latency ?? pool.lastLatencyMs,
      latencySamples: latency != null ? Math.min((pool.latencySamples || 0) + 1, MAX_LATENCY_SAMPLES) : (pool.latencySamples || 0),
      latencyHistory, // F1: last 100 latencies for the UI sparkline
      consecutiveFailures: 0,
      cooldownUntil: null,
      testStatus: "active",
      lastError: null,
    });
    if ((pool.consecutiveFailures || 0) > 0) {
      const log = await getLogger();
      log?.info?.("PROXY", `Pool ${pool.name || poolId} recovered after ${pool.consecutiveFailures} failure(s)`);
    }
  } catch (e) {
    console.warn("[ProxyHealth] reportProxySuccess failed (swallowed):", e?.message ?? e);
  }
}

async function testRelay(relayUrl, timeoutMs = TEST_TIMEOUT_MS) {
  const { fetch: undiciFetch } = await import("undici");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await undiciFetch(relayUrl, {
      method: "GET",
      headers: {
        "x-relay-target": "https://httpbin.org",
        "x-relay-path": "/get",
      },
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status, error: res.ok ? null : `Relay returned status ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err?.name === "AbortError" ? "Relay test timed out" : (err?.message || String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pick the best healthy (active + not cooling down) pool from a candidate
 * list and return its fetch options. Used for cross-pool failover.
 * Healthy candidates are ordered by health score (best first).
 * Returns null when no candidate qualifies.
 */
export async function getPoolProxyOptions(poolIds) {
  if (!poolIds || poolIds.length === 0) return null;
  try {
    const { getProxyPools } = await loadRepo();
    const pools = await getProxyPools({ isActive: true });
    const now = Date.now();
    const candidates = pools
      .filter((p) => poolIds.includes(p.id) && p.proxyUrl && !isPoolInCooldown(p, now))
      .sort(
        (a, b) =>
          (a.priority ?? 50) - (b.priority ?? 50) || // lower priority = tried first
          computePoolScore(b) - computePoolScore(a) // tie-break by health
      );
    const pool = candidates[0];
    if (!pool) return null;
    return {
      id: pool.id,
      connectionProxyUrl: isRelayPool(pool) ? "" : pool.proxyUrl,
      vercelRelayUrl: isRelayPool(pool) ? pool.proxyUrl : "",
    };
  } catch (e) {
    console.warn("[ProxyHealth] getPoolProxyOptions failed (swallowed):", e?.message ?? e);
    return null;
  }
}

/**
 * Test one proxy pool's connectivity (http pools via proxyTest, relays via header spec).
 * @returns {Promise<{ok:boolean, status?:number, error?:string|null, elapsedMs?:number}>}
 */
export async function testProxyPoolConnectivity(pool) {
  const startedAt = Date.now();
  // Lazy import: proxyTest pulls in undici, which is not available in some
  // test environments — only load it when actually testing a proxy.
  const { testProxyUrl } = await import("./proxyTest.js");
  const result = isRelayPool(pool)
    ? await testRelay(pool.proxyUrl)
    : await testProxyUrl({ proxyUrl: pool.proxyUrl });
  return { ...result, elapsedMs: Date.now() - startedAt };
}

/**
 * One scheduler tick: auto-test all active pools, update status/metrics,
 * and let healthy results clear cooldown state. Fail-open per pool.
 * `connectivityTest` is injectable for tests (defaults to the real test fn).
 */
export async function runProxyHealthTick({ connectivityTest } = {}) {
  if (tickRunning) return;
  tickRunning = true;
  const testFn = connectivityTest || testProxyPoolConnectivity;
  try {
    const { getProxyPools, updateProxyPool } = await loadRepo();
    const pools = await getProxyPools({ isActive: true });
    if (!pools || pools.length === 0) return;

    await Promise.allSettled(
      pools.map(async (pool) => {
        try {
          const result = await testFn(pool);
          if (result.ok) {
            await updateProxyPool(pool.id, {
              testStatus: "active",
              lastTestedAt: new Date().toISOString(),
              lastError: null,
              lastLatencyMs: result.elapsedMs,
              consecutiveFailures: 0,
              cooldownUntil: null,
              successCount: (pool.successCount || 0) + 1,
              requestCount: (pool.requestCount || 0) + 1,
              avgLatencyMs: pushAvgLatency(pool.avgLatencyMs, pool.latencySamples, result.elapsedMs),
              latencySamples: Math.min((pool.latencySamples || 0) + 1, MAX_LATENCY_SAMPLES),
              latencyHistory: [...(pool.latencyHistory || []).slice(-99), Math.round(result.elapsedMs)], // F1 sparkline
            });
          } else {
            const failures = (pool.consecutiveFailures || 0) + 1;
            const enteredCooldown = failures >= COOLDOWN_THRESHOLD && (pool.consecutiveFailures || 0) < COOLDOWN_THRESHOLD;
            await updateProxyPool(pool.id, {
              testStatus: "error",
              lastTestedAt: new Date().toISOString(),
              lastError: result.error || `Proxy test failed with status ${result.status}`,
              lastErrorAt: new Date().toISOString(),
              failCount: (pool.failCount || 0) + 1,
              requestCount: (pool.requestCount || 0) + 1,
              consecutiveFailures: failures,
              cooldownUntil: failures >= COOLDOWN_THRESHOLD
                ? new Date(Date.now() + nextCooldownMs(failures)).toISOString()
                : pool.cooldownUntil,
            });
            if (enteredCooldown) {
              await notifyPoolCooldown(
                { ...pool, consecutiveFailures: failures },
                nextCooldownMs(failures),
                result.error || `Proxy test failed with status ${result.status}`
              );
              if (pool.autoUnbind !== false) {
                await autoUnbindPool(pool.id, pool.name);
              }
            }
          }
        } catch (e) {
          console.warn("[ProxyHealth] pool tick failed (swallowed):", pool?.id, e?.message ?? e);
        }
      })
    );
  } catch (e) {
    console.warn("[ProxyHealth] tick failed (swallowed):", e?.message ?? e);
  } finally {
    tickRunning = false;
  }
}

/**
 * Start the background auto-test interval. Safe to call multiple times (no-op if started).
 */
export function startProxyHealthMonitor({ intervalMs } = {}) {
  if (started) return false;
  if (isTruthyEnv(process.env.DISABLE_PROXY_HEALTH_MONITOR)) {
    console.log("[ProxyHealth] Disabled via DISABLE_PROXY_HEALTH_MONITOR");
    return false;
  }
  if (isNonServerRuntime()) {
    console.log("[ProxyHealth] Skip start outside long-running server runtime");
    return false;
  }

  started = true;
  const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : MONITOR_INTERVAL_MS;

  const safeTick = () => {
    runProxyHealthTick().catch((e) => {
      console.warn("[ProxyHealth] Unhandled tick rejection (swallowed):", e?.message ?? e);
    });
  };

  initialTimeoutHandle = setTimeout(safeTick, INITIAL_DELAY_MS);
  if (initialTimeoutHandle.unref) initialTimeoutHandle.unref();

  intervalHandle = setInterval(safeTick, period);
  if (intervalHandle.unref) intervalHandle.unref();

  console.log("[ProxyHealth] Auto-test scheduler started", { intervalMs: period, initialDelayMs: INITIAL_DELAY_MS });
  return true;
}

export function stopProxyHealthMonitor() {
  if (initialTimeoutHandle) {
    clearTimeout(initialTimeoutHandle);
    initialTimeoutHandle = null;
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (started) {
    started = false;
    console.log("[ProxyHealth] Auto-test scheduler stopped");
  }
}
