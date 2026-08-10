import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";
const DEFAULT_HEADROOM_URL = process.env.HEADROOM_URL || "http://localhost:8787";

const DEFAULT_SETTINGS = {
  cloudEnabled: false,
  tunnelEnabled: false,
  tunnelUrl: "",
  tunnelProvider: "cloudflare",
  tailscaleEnabled: false,
  tailscaleUrl: "",
  stickyRoundRobinLimit: 3,
  providerStrategies: {},
  quotaVisibility: {},
  comboStrategy: "fallback",
  comboStickyRoundRobinLimit: 1,
  comboStrategies: {},
  capacityAdapter: {
    vision: { enabled: true, roundRobin: false, models: [] },
    pdf: { enabled: false, roundRobin: false, models: [] },
    audioInput: { enabled: true, roundRobin: false, models: [] },
    videoInput: { enabled: false, roundRobin: false, models: [] },
  },
  requireLogin: true,
  requireApiKey: true,
  apiKeyRateLimit: { enabled: false, rpm: 60 },
  apiKeyDailyQuota: { enabled: false, requests: 500 },
  tunnelDashboardAccess: true,
  authMode: "password",
  oidcIssuerUrl: "",
  oidcClientId: "",
  oidcClientSecret: "",
  oidcScopes: "openid profile email",
  oidcLoginLabel: "Sign in with OIDC",
  enableObservability: false,
  observabilityMaxRecords: 1000,
  observabilityBatchSize: 20,
  observabilityFlushIntervalMs: 5000,
  observabilityMaxJsonSize: 5,
  outboundProxyEnabled: false,
  outboundProxyUrl: "",
  outboundNoProxy: "",
  mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
  dnsToolEnabled: {},
  rtkEnabled: true,
  headroomEnabled: false,
  headroomUrl: DEFAULT_HEADROOM_URL,
  headroomCompressUserMessages: false,
  headroomMinBytes: 4096,
  cavemanEnabled: false,
  cavemanLevel: "full",
  ponytailEnabled: false,
  ponytailLevel: "full",
  pxpipeEnabled: false,
  pxpipeAutoInstall: true,
  pxpipeMinChars: 25000,
  pxpipeTimeoutMs: 15000,
  dedupMessages: false,        // drop consecutive identical messages
  historyTrimMaxBytes: 0,      // 0 = off; oldest messages dropped above this byte cap
  historyTrimKeepMin: 6,       // messages always kept at the tail (besides system)
  summaryInject: false,        // collapse middle history into one heuristic summary
  summaryInjectAboveBytes: 90000,
  forceTruncateBytes: 0,       // 0 = off; tool_result > N bytes → head/tail truncation
  dedupImageContent: false,    // drop repeated identical image blocks
  dropEmptyMessages: false,    // drop empty/whitespace-only messages
  capOutputTokens: false,      // adaptive max_tokens estimate (never touches thinking)
  tokenSaverMode: "off",       // off|lite|full|ultra quick-set presets
  // Response caching (exact-match, non-stream, in-memory)
  responseCacheEnabled: false,
  responseCacheTtlSeconds: 300,
  responseCacheMaxEntries: 200,
  // Latency-aware account routing (tiebreak after learning score)
  latencyAwareRouting: false,
  // Rate-limit queueing: wait out short 429 cooldowns on the same account
  rateLimitQueueEnabled: false,
  rateLimitQueueMaxWaitMs: 10000,
  tokenSaverPlans: [],           // array of {id, modelRegex, format, minPayloadBytes, savers:{rtk,headroom,pxpipe,caveman,ponytail}, budgetTokens, degradeTo}
  tokenSaverBudget: { enabled: false, dailyTokens: 0, warnThresholdPct: 80, action: "warn" }, // warn|degrade|block
  tokenSaverAdvisor: false,      // auto-suggest degrade model on budget
};

async function readRaw() {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  return row ? parseJson(row.data, {}) : {};
}

// Merge raw settings with defaults; backward-compat for missing keys
function mergeWithDefaults(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  for (const [key, defVal] of Object.entries(DEFAULT_SETTINGS)) {
    if (merged[key] === undefined) {
      if (
        key === "outboundProxyEnabled" &&
        typeof merged.outboundProxyUrl === "string" &&
        merged.outboundProxyUrl.trim()
      ) {
        merged[key] = true;
      } else {
        merged[key] = defVal;
      }
    }
  }
  return merged;
}

export async function getSettings() {
  const raw = await readRaw();
  return mergeWithDefaults(raw);
}

// Atomic read-merge-write inside transaction (prevents losing concurrent updates)
export async function updateSettings(updates) {
  const db = await getAdapter();
  let next;
  db.transaction(function () {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const current = row ? parseJson(row.data, {}) : {};
    next = { ...current, ...updates };
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(next)],
    );
  });
  return mergeWithDefaults(next);
}

export async function isCloudEnabled() {
  const settings = await getSettings();
  return settings.cloudEnabled === true;
}

export async function getCloudUrl() {
  const settings = await getSettings();
  return (
    settings.cloudUrl ||
    process.env.CLOUD_URL ||
    process.env.NEXT_PUBLIC_CLOUD_URL ||
    ""
  );
}

export async function exportSettings() {
  return await readRaw();
}
