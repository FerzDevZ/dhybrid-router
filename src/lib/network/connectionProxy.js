import { getProxyPoolById } from "@/models";
import { makeKv } from "../db/helpers/kvStore.js";

// Safely normalize any value into a trimmed string.
function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

// ─── Proxy pool rotation state ──────────────────────────────────────
// In-memory cursor for fast path + persistent kv cursor so rotation
// survives restarts. kv writes are throttled per provider (at most one
// write per 5s; intermediate steps live in memory).
const rotateState = new Map(); // providerId → { index }
const rotationKv = makeKv("proxyRotation");
const KV_WRITE_THROTTLE_MS = 5000;
const lastKvWriteAtByProvider = new Map(); // providerId → timestamp

async function loadRotationState(providerId) {
  let state = rotateState.get(providerId);
  if (state) return state;
  try {
    const saved = await rotationKv.get(providerId, { index: -1 });
    state = { index: Number.isFinite(saved?.index) ? saved.index : -1 };
  } catch {
    state = { index: -1 }; // fail-open: start fresh if kv unavailable
  }
  rotateState.set(providerId, state);
  return state;
}

async function saveRotationState(providerId, state) {
  const now = Date.now();
  const last = lastKvWriteAtByProvider.get(providerId) || 0;
  if (now - last < KV_WRITE_THROTTLE_MS) return;
  lastKvWriteAtByProvider.set(providerId, now);
  rotationKv.set(providerId, { index: state.index }).catch(() => {
    /* fail-open */
  });
}

/**
 * Pick one proxy pool ID from a list based on strategy.
 * Pools inside circuit-breaker cooldown are skipped (health-aware rotation);
 * if every pool is cooling down, fall back to the full list so traffic
 * is never hard-blocked by health state alone.
 *
 * round-robin: cycle sequentially (persistent cursor in kv, throttled writes)
 * random:      uniform random pick
 * none/single: return first healthy entry
 */
export async function pickProxyPoolId(poolIds, strategy, providerId) {
  if (!poolIds || poolIds.length === 0) return null;
  if (poolIds.length === 1) return poolIds[0];

  // Load cooldown state (relative import — safe under Next bundle and native ESM)
  let cooldownById = new Map();
  let poolsById = new Map();
  try {
    const { getProxyPools } = await import("../../lib/db/repos/proxyPoolsRepo.js");
    const pools = await getProxyPools({ isActive: true });
    const now = Date.now();
    poolsById = new Map(pools.map((p) => [p.id, p]));
    cooldownById = new Map(
      pools
        .filter((p) => p.cooldownUntil && new Date(p.cooldownUntil).getTime() > now)
        .map((p) => [p.id, true])
    );
  } catch {
    /* fail-open: ignore cooldown state if it can't be loaded */
  }

  const healthyIds = poolIds.filter((id) => !cooldownById.has(id));
  const candidates = healthyIds.length > 0 ? healthyIds : poolIds;

  if (strategy === "round-robin") {
    const state = await loadRotationState(providerId);
    state.index = (state.index + 1) % candidates.length;
    await saveRotationState(providerId, state);
    return candidates[state.index];
  }

  if (strategy === "weighted") {
    // Health-based weighted pick: best pools get higher probability,
    // others still get a chance (bias via squared random).
    let scored = candidates.map((id) => ({ id, score: 50 }));
    try {
      const { computePoolScore } = await import("./proxyHealth.js");
      scored = candidates
        .map((id) => ({ id, score: computePoolScore(poolsById.get(id) || {}) }))
        .sort((a, b) => b.score - a.score);
    } catch {
      /* fail-open: uniform pick below */
    }
    return scored[Math.floor(Math.random() ** 2 * scored.length)].id;
  }

  if (strategy === "random") {
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  return candidates[0]; // "none" or unknown
}

/**
 * Normalize legacy proxy configuration.
 */
function normalizeLegacyProxy(providerSpecificData = {}) {
  const connectionProxyEnabled =
    providerSpecificData?.connectionProxyEnabled === true;

  const connectionProxyUrl = normalizeString(
    providerSpecificData?.connectionProxyUrl
  );

  const connectionNoProxy = normalizeString(
    providerSpecificData?.connectionNoProxy
  );

  return {
    connectionProxyEnabled,
    connectionProxyUrl,
    connectionNoProxy,
  };
}

/**
 * Resolve final proxy configuration.
 *
 * Priority:
 * 1. Proxy Pool (or per-model override when `options.poolIdOverride` is set)
 * 2. Legacy Proxy
 * 3. No Proxy
 */
export async function resolveConnectionProxyConfig(
  providerSpecificData = {},
  options = {}
) {
  try {
    const raw = normalizeString(providerSpecificData?.proxyPoolId);
    // "__none__" means explicitly disabled
    const overrideRaw = normalizeString(options?.poolIdOverride);
    const proxyPoolId =
      overrideRaw === "__none__"
        ? ""
        : overrideRaw || (raw === "__none__" ? "" : raw);

    const legacy = normalizeLegacyProxy(providerSpecificData);

    /**
     * -----------------------------
     * Proxy Pool Resolution
     * -----------------------------
     */
    if (proxyPoolId) {
      const proxyPool = await getProxyPoolById(proxyPoolId);

      const proxyUrl = normalizeString(proxyPool?.proxyUrl);
      const noProxy = normalizeString(proxyPool?.noProxy);

      const isValidPool =
        proxyPool &&
        proxyPool.isActive === true &&
        proxyUrl;

      if (isValidPool) {
        /**
         * Vercel/Cloudflare relay proxies use base URL rewriting
         * instead of HTTP_PROXY environment variables.
         */
        if (proxyPool.type === "vercel" || proxyPool.type === "cloudflare" || proxyPool.type === "deno") {
          return {
            source: proxyPool.type,

            proxyPoolId,
            proxyPool,

            connectionProxyEnabled: false,
            connectionProxyUrl: "",
            connectionNoProxy: noProxy,

            strictProxy: proxyPool.strictProxy === true,
            maxFailover: proxyPool.maxFailover ?? 2,
            allowFallbackDirect: proxyPool.allowFallbackDirect !== false,
            maxConcurrency: proxyPool.maxConcurrency ?? 0,

            vercelRelayUrl: proxyUrl, // Still mapped to vercelRelayUrl in the unified payload since they use the exact same header spec
          };
        }

        /**
         * Standard proxy pool
         */
        return {
          source: "pool",

          proxyPoolId,
          proxyPool,

          connectionProxyEnabled: true,
          connectionProxyUrl: proxyUrl,
          connectionNoProxy: noProxy,

          strictProxy: proxyPool.strictProxy === true,
          maxFailover: proxyPool.maxFailover ?? 2,
          allowFallbackDirect: proxyPool.allowFallbackDirect !== false,
          maxConcurrency: proxyPool.maxConcurrency ?? 0,
        };
      }
    }

    /**
     * -----------------------------
     * Legacy Proxy Fallback
     * -----------------------------
     */
    if (
      legacy.connectionProxyEnabled &&
      legacy.connectionProxyUrl
    ) {
      return {
        source: "legacy",

        proxyPoolId: proxyPoolId || null,
        proxyPool: null,

        ...legacy,
      };
    }

    /**
     * -----------------------------
     * No Proxy Config
     * -----------------------------
     */
    return {
      source: "none",

      proxyPoolId: proxyPoolId || null,
      proxyPool: null,

      ...legacy,
    };
  } catch (error) {
    console.error(
      "[resolveConnectionProxyConfig] Failed to resolve proxy config:",
      error
    );

    return {
      source: "error",

      proxyPoolId: null,
      proxyPool: null,

      connectionProxyEnabled: false,
      connectionProxyUrl: "",
      connectionNoProxy: "",

      strictProxy: false,
    };
  }
}
