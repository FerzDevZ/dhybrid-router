import { Readable } from "stream";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { dbg } from "./debugLog.js";

const originalFetch = globalThis.fetch;
const proxyDispatchers = new Map();

// Lazy-loaded so this module has no static dependency on src/ (keeps it
// importable from Next bundle, tests, and standalone CLI alike). Fail-open.
let proxyHealthPromise = null;
function getProxyHealth() {
  if (!proxyHealthPromise) {
    proxyHealthPromise = import("../../src/lib/network/proxyHealth.js").catch((e) => {
      proxyHealthPromise = null; // allow retry on next call
      console.warn("[ProxyFetch] proxyHealth import failed (metrics disabled):", e?.message ?? e);
      return null;
    });
  }
  return proxyHealthPromise;
}

// ─── TLS fingerprinting via got-scraping (browser-like JA3) ───────────────
// Disabled: not in use. Kept commented for future re-enable.
// Restore the original block to re-enable per-host JA3 spoofing.
/*
let _gotScraping = null;
let _gotScrapingChecked = false;
const _gotScrapingLoggedHosts = new Set();

async function getGotScraping() {
  if (_gotScrapingChecked) return _gotScraping;
  _gotScrapingChecked = true;
  try {
    const mod = await import("got-scraping");
    _gotScraping = typeof mod.gotScraping === "function" ? mod.gotScraping : null;
    if (_gotScraping) dbg("TLS", "got-scraping loaded (browser-like JA3 enabled)");
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping unavailable, falling back to native fetch: ${e.message}`);
    _gotScraping = null;
  }
  return _gotScraping;
}

async function gotScrapingFetch(url, options) {
  const gs = await getGotScraping();
  if (!gs) return null;

  const method = (options.method || "GET").toUpperCase();
  const headersInit = options.headers || {};
  const headers = headersInit instanceof Headers
    ? Object.fromEntries(headersInit.entries())
    : { ...headersInit };

  return new Promise((resolve, reject) => {
    let settled = false;
    const stream = gs.stream({
      url,
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : options.body,
      throwHttpErrors: false,
      retry: { limit: 0 },
      timeout: { request: undefined },
      followRedirect: false,
      decompress: true,
    });

    if (options.signal) {
      const onAbort = () => { try { stream.destroy(new Error("aborted")); } catch { } };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    stream.once("response", (res) => {
      if (settled) return;
      settled = true;
      const resHeaders = new Headers();
      for (const [k, v] of Object.entries(res.headers || {})) {
        if (Array.isArray(v)) v.forEach((x) => resHeaders.append(k, String(x)));
        else if (v != null) resHeaders.set(k, String(v));
      }
      const body = Readable.toWeb(stream);
      resolve(new Response(body, { status: res.statusCode, statusText: res.statusMessage || "", headers: resHeaders }));
    });

    stream.once("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function tryGotScrapingFetch(url, options) {
  try {
    const res = await gotScrapingFetch(url, options);
    if (res) {
      try {
        const host = new URL(typeof url === "string" ? url : url.toString()).hostname;
        if (!_gotScrapingLoggedHosts.has(host)) {
          _gotScrapingLoggedHosts.add(host);
          dbg("TLS", `using got-scraping for ${host}`);
        }
      } catch { }
    }
    return res;
  } catch (e) {
    console.warn(`[ProxyFetch] got-scraping request failed, fallback to native fetch: ${e.message}`);
    return null;
  }
}
*/

// DNS cache — use Map to avoid prototype pollution via malformed hostnames
const DNS_CACHE = new Map();
const MITM_BYPASS_HOSTS = [
  "cloudcode-pa.googleapis.com",
  "daily-cloudcode-pa.googleapis.com",
  "api.individual.githubcopilot.com",
  "q.us-east-1.amazonaws.com",
  "codewhisperer.us-east-1.amazonaws.com",
  "api2.cursor.sh",
];
const GOOGLE_DNS_SERVERS = ["8.8.8.8", "8.8.4.4"];
const HTTPS_PORT = 443;
const HTTP_SUCCESS_MIN = 200;
const HTTP_SUCCESS_MAX = 300;

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

/**
 * Resolve real IP using Google DNS (bypass system DNS)
 */
async function resolveRealIP(hostname) {
  const cached = DNS_CACHE.get(hostname);
  if (cached && Date.now() < cached.expiry) return cached.ip;

  try {
    const dns = await import("dns");
    const { promisify } = await import("util");
    const resolver = new dns.Resolver();
    resolver.setServers(GOOGLE_DNS_SERVERS);
    const resolve4 = promisify(resolver.resolve4.bind(resolver));
    const addresses = await resolve4(hostname);
    DNS_CACHE.set(hostname, { ip: addresses[0], expiry: Date.now() + MEMORY_CONFIG.dnsCacheTtlMs });
    return addresses[0];
  } catch (error) {
    console.warn(`[ProxyFetch] DNS resolve failed for ${hostname}:`, error.message);
    return null;
  }
}

/**
 * Check if request should bypass MITM DNS redirect
 */
function shouldBypassMitmDns(url) {
  try {
    const hostname = new URL(url).hostname;
    return MITM_BYPASS_HOSTS.some(host => hostname.includes(host));
  } catch { return false; }
}

function shouldBypassByNoProxy(targetUrl, noProxyValue) {
  const noProxy = normalizeString(noProxyValue);
  if (!noProxy) return false;

  let hostname;
  try { hostname = new URL(targetUrl).hostname.toLowerCase(); } catch { return false; }
  const patterns = noProxy.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);

  return patterns.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.startsWith(".")) return hostname.endsWith(pattern) || hostname === pattern.slice(1);
    return hostname === pattern || hostname.endsWith(`.${pattern}`);
  });
}

/**
 * Get proxy URL from environment
 */
function getEnvProxyUrl(targetUrl) {
  const noProxy = process.env.NO_PROXY || process.env.no_proxy;
  if (shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  let protocol;
  try { protocol = new URL(targetUrl).protocol; } catch { return null; }

  if (protocol === "https:") {
    return process.env.HTTPS_PROXY || process.env.https_proxy ||
      process.env.ALL_PROXY || process.env.all_proxy;
  }

  return process.env.HTTP_PROXY || process.env.http_proxy ||
    process.env.ALL_PROXY || process.env.all_proxy;
}

/**
 * Normalize proxy URL (allow host:port)
 */
function normalizeProxyUrl(proxyUrl) {
  const normalizedInput = normalizeString(proxyUrl);
  if (!normalizedInput) return null;

  try {

    new URL(normalizedInput);
    return normalizedInput;
  } catch {
    // Allow "127.0.0.1:7890" style values
    return `http://${normalizedInput}`;
  }
}

function resolveConnectionProxyUrl(targetUrl, proxyOptions) {
  const enabled = proxyOptions?.enabled === true || proxyOptions?.connectionProxyEnabled === true;
  if (!enabled) return null;

  const proxyUrlRaw = normalizeString(proxyOptions?.url ?? proxyOptions?.connectionProxyUrl);
  if (!proxyUrlRaw) return null;

  const noProxy = normalizeString(proxyOptions?.noProxy ?? proxyOptions?.connectionNoProxy);
  if (noProxy && shouldBypassByNoProxy(targetUrl, noProxy)) return null;

  return normalizeProxyUrl(proxyUrlRaw);
}

/**
 * Create proxy dispatcher lazily (undici-compatible)
 * SOCKS proxies get a socks-proxy-agent-based fetch (undici has no SOCKS dispatcher).
 */
async function getDispatcher(proxyUrl) {
  const normalized = normalizeProxyUrl(proxyUrl);
  if (!normalized) return null;

  if (isSocksUrl(normalized)) return { socks: normalized };

  if (!proxyDispatchers.has(normalized)) {
    // Evict oldest entry if max size reached
    if (proxyDispatchers.size >= MEMORY_CONFIG.proxyDispatchersMaxSize) {
      proxyDispatchers.delete(proxyDispatchers.keys().next().value);
    }
    const { ProxyAgent } = await import("undici");
    proxyDispatchers.set(normalized, new ProxyAgent({ uri: normalized }));
  }

  return proxyDispatchers.get(normalized);
}

function isSocksUrl(proxyUrl) {
  return /^socks(4|4a|5|5h)?:\/\//i.test(normalizeString(proxyUrl));
}

// ── Per-pool concurrency semaphore (E3) ─────────────────────────
const poolSlots = new Map(); // poolId -> { inflight, waiters }

async function acquireSlot(poolId, max) {
  if (!poolId || !max || max < 1) return;
  let entry = poolSlots.get(poolId);
  if (!entry) {
    entry = { inflight: 0, waiters: [] };
    poolSlots.set(poolId, entry);
  }
  if (entry.inflight < max) {
    entry.inflight += 1;
    return;
  }
  await new Promise((resolve) => {
    entry.waiters.push({ resolve });
  });
  entry.inflight += 1; // slot granted by releaseSlot
}

function releaseSlot(poolId) {
  if (!poolId) return;
  const entry = poolSlots.get(poolId);
  if (!entry) return;
  const waiter = entry.waiters.shift();
  if (waiter) {
    waiter.resolve(); // pass the slot straight to the next waiter
    return;
  }
  entry.inflight -= 1;
  if (entry.inflight <= 0) poolSlots.delete(poolId);
}

// ── Reused keep-alive SOCKS agents (G1) ─────────────────────────
const socksAgents = new Map(); // socksUrl -> SocksProxyAgent
const SOCKS_CONN_ERRORS = new Set(["ECONNRESET", "EPIPE", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"]);

function getSocksAgent(socksUrl, SocksProxyAgentCtor) {
  let agent = socksAgents.get(socksUrl);
  if (!agent) {
    agent = new SocksProxyAgentCtor(socksUrl, { keepAlive: true });
    if (socksAgents.size >= MEMORY_CONFIG.proxyDispatchersMaxSize) {
      const firstKey = socksAgents.keys().next().value;
      if (firstKey !== undefined) socksAgents.delete(firstKey);
    }
    socksAgents.set(socksUrl, agent);
  }
  return agent;
}

function evictSocksAgent(socksUrl) {
  socksAgents.delete(socksUrl);
}

/**
 * Fetch through a SOCKS proxy via node http(s).request + SocksProxyAgent.
 * Response shape mirrors what undici fetch returns for the parts we use.
 */
async function socksFetch(targetUrl, options, socksUrl) {
  const { SocksProxyAgent } = await import("socks-proxy-agent");
  const httpsModule = await import("https");
  const httpModule = await import("http");
  const https = httpsModule.default ?? httpsModule;
  const http = httpModule.default ?? httpModule;

  const urlObj = new URL(targetUrl);
  const agent = getSocksAgent(socksUrl, SocksProxyAgent);

  return new Promise((resolve, reject) => {
    const req = (urlObj.protocol === "https:" ? https : http).request(
      targetUrl,
      {
        method: (options.method || "GET").toUpperCase(),
        headers: { ...options.headers },
        agent,
        signal: options.signal,
      },
      (res) => {
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) v.forEach((x) => headers.append(k, String(x)));
          else if (v != null) headers.set(k, String(v));
        }
        resolve(
          new Response(Readable.toWeb(res), {
            status: res.statusCode,
            statusText: res.statusMessage || "",
            headers,
          })
        );
      }
    );
    req.on("error", (err) => {
      // Connection-level errors → drop the cached agent so the next request rebuilds it
      if (SOCKS_CONN_ERRORS.has(err?.code)) evictSocksAgent(socksUrl);
      reject(err);
    });
    if (options.body != null && options.body !== "") {
      req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

/**
 * Create HTTPS request with manual socket connection (bypass DNS)
 */
async function createBypassRequest(parsedUrl, realIP, options) {
  const httpsModule = await import("https");
  const netModule = await import("net");
  // CJS modules expose exports via .default in ESM dynamic import context
  const https = httpsModule.default ?? httpsModule;
  const net = netModule.default ?? netModule;

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();

    socket.connect(HTTPS_PORT, realIP, () => {
      const reqOptions = {
        socket,
        // SNI + cert hostname are validated against the hostname the caller
        // asked for, not the IP we connected to. This keeps the DNS-bypass
        // (avoiding /etc/hosts MITM) while still rejecting on-path attackers
        // that present a different cert. The MITM_BYPASS_HOSTS targets are
        // all public-CA-issued (Google / GitHub / AWS / Cursor) so default
        // verification works without any extra trust store.
        servername: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || "POST",
        headers: {
          ...options.headers,
          Host: parsedUrl.hostname,
        },
      };

      const req = https.request(reqOptions, (res) => {
        const response = {
          ok: res.statusCode >= HTTP_SUCCESS_MIN && res.statusCode < HTTP_SUCCESS_MAX,
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: new Map(Object.entries(res.headers)),
          body: Readable.toWeb(res),
          text: async () => {
            const chunks = [];
            for await (const chunk of res) chunks.push(chunk);
            return Buffer.concat(chunks).toString();
          },
          json: async () => JSON.parse(await response.text()),
        };
        resolve(response);
      });

      req.on("error", reject);
      if (options.body) {
        req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });

    socket.on("error", reject);
  });
}

/**
 * Wrap a fetch with pool-level metrics reporting (fail-open: metric
 * writes never affect the request). Pool id comes from proxyOptions.
 */
async function timedProxyFetch(poolId, fetchFn) {
  const startedAt = Date.now();
  try {
    const res = await fetchFn();
    if (poolId) {
      const ph = await getProxyHealth();
      if (ph) ph.reportProxySuccess(poolId, Date.now() - startedAt).catch(() => {});
    }
    return res;
  } catch (err) {
    if (poolId) {
      const ph = await getProxyHealth();
      if (ph) ph.reportProxyFailure(poolId, err?.message || String(err)).catch(() => {});
    }
    throw err;
  }
}

/**
 * Build a single fetch plan for the current proxy options.
 * Returns { kind, poolId, run } where kind ∈ relay | mitm | proxy | bypass | direct.
 * "bypass" (MITM direct-DNS) and "direct" are terminal — no pool retry.
 */
async function buildPlan(targetUrl, url, options, proxyOptions, poolId) {
  // Vercel relay: forward request via relay headers
  const vercelRelayUrl = normalizeString(proxyOptions?.vercelRelayUrl);
  if (vercelRelayUrl) {
    const parsed = new URL(targetUrl);
    const relayHeaders = {
      ...options.headers,
      "x-relay-target": `${parsed.protocol}//${parsed.host}`,
      "x-relay-path": `${parsed.pathname}${parsed.search}`,
    };
    return {
      kind: "relay",
      poolId,
      run: () => originalFetch(vercelRelayUrl, { ...options, headers: relayHeaders }),
    };
  }

  const connectionProxyUrl = resolveConnectionProxyUrl(targetUrl, proxyOptions);
  const envProxyUrl = connectionProxyUrl ? null : normalizeProxyUrl(getEnvProxyUrl(targetUrl));
  const proxyUrl = connectionProxyUrl || envProxyUrl;

  // MITM DNS bypass: for known MITM-intercepted hosts, resolve real IP to avoid DNS spoof
  if (shouldBypassMitmDns(targetUrl)) {
    if (proxyUrl) {
      // Proxy resolves DNS externally (not affected by /etc/hosts) — use proxy directly
      return {
        kind: "mitm",
        poolId,
        run: async () => {
          const dispatcher = await getDispatcher(proxyUrl);
          if (dispatcher?.socks) return socksFetch(targetUrl, options, dispatcher.socks);
          return originalFetch(url, { ...options, dispatcher });
        },
      };
    }
    // No proxy — manually resolve real IP to bypass DNS spoof
    return {
      kind: "bypass",
      poolId: null,
      run: async () => {
        try {
          const parsedUrl = new URL(targetUrl);
          const realIP = await resolveRealIP(parsedUrl.hostname);
          if (realIP) return await createBypassRequest(parsedUrl, realIP, options);
        } catch (error) {
          console.warn(`[ProxyFetch] MITM bypass failed: ${error.message}`);
        }
        return originalFetch(url, options);
      },
    };
  }

  if (proxyUrl) {
    return {
      kind: "proxy",
      poolId,
      run: async () => {
        const dispatcher = await getDispatcher(proxyUrl);
        if (dispatcher?.socks) return socksFetch(targetUrl, options, dispatcher.socks);
        return originalFetch(url, { ...options, dispatcher });
      },
    };
  }

  return { kind: "direct", poolId: null, run: () => originalFetch(url, options) };
}

/**
 * Pick the next untried, healthy pool for failover (via proxyHealth).
 * Returns null when no candidate remains.
 */
async function pickFailoverPool(poolIds, tried) {
  if (!poolIds || poolIds.length === 0) return null;
  const candidates = poolIds.filter((id) => !tried.has(id));
  if (candidates.length === 0) return null;
  const ph = await getProxyHealth();
  if (!ph || typeof ph.getPoolProxyOptions !== "function") return null;
  return ph.getPoolProxyOptions(candidates).catch(() => null);
}

export async function proxyAwareFetch(url, options = {}, proxyOptions = null) {
  const targetUrl = typeof url === "string" ? url : url.toString();
  const poolIds = Array.isArray(proxyOptions?.connectionProxyPoolIds)
    ? proxyOptions.connectionProxyPoolIds
    : [];
  const isStrict = proxyOptions?.strictProxy === true || proxyOptions?.poolAllowFallbackDirect === false;
  const maxFailover = Math.max(1, Number(proxyOptions?.poolMaxFailover) || 2);
  let currentProxyOptions = proxyOptions;
  let currentPoolId = normalizeString(proxyOptions?.connectionProxyPoolId) || null;
  const tried = new Set();

  for (;;) {
    const plan = await buildPlan(targetUrl, url, options, currentProxyOptions, currentPoolId);

    // Terminal plans (no proxy involved) — never retried
    if (plan.kind === "direct" || plan.kind === "bypass") return plan.run();

    try {
      // Per-pool concurrency cap (E3) — 0 = unlimited
      if (plan.poolId) await acquireSlot(plan.poolId, Number(currentProxyOptions?.poolMaxConcurrency) || 0);
      return await timedProxyFetch(plan.poolId, plan.run);
    } catch (err) {
      if (plan.poolId) tried.add(plan.poolId);

      // Failover: try the next healthy pool (if any), capped by maxFailover
      const next = poolIds.length > 0 && tried.size < maxFailover
        ? await pickFailoverPool(poolIds, tried)
        : null;
      if (next) {
        currentProxyOptions = {
          ...proxyOptions,
          connectionProxyUrl: next.connectionProxyUrl,
          vercelRelayUrl: next.vercelRelayUrl,
          connectionProxyPoolId: next.id,
        };
        currentPoolId = next.id;
        continue;
      }

      // All pools exhausted (or no pools) — fallback
      if (plan.kind === "mitm") {
        // Keep old MITM behavior: try direct DNS bypass before giving up
        try {
          const parsedUrl = new URL(targetUrl);
          const realIP = await resolveRealIP(parsedUrl.hostname);
          if (realIP) return await createBypassRequest(parsedUrl, realIP, options);
        } catch (error) {
          console.warn(`[ProxyFetch] MITM bypass failed: ${error.message}`);
        }
      }
      if (isStrict) {
        throw new Error(`[ProxyFetch] Proxy required but failed (strictProxy=true): ${err.message}`);
      }
      console.warn(`[ProxyFetch] Proxy failed, falling back to direct: ${err.message}`);
      return originalFetch(url, options);
    } finally {
      if (plan.poolId) releaseSlot(plan.poolId);
    }
  }
}

/**
 * Patched global fetch with env-proxy support and MITM DNS bypass
 */
async function patchedFetch(url, options = {}) {
  return proxyAwareFetch(url, options, null);
}

// Idempotency guard — only patch once to avoid wrapping multiple times
if (globalThis.fetch !== patchedFetch) {
  globalThis.fetch = patchedFetch;
}

export default patchedFetch;
