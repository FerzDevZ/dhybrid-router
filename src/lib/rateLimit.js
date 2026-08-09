// Per-API-key request throttling:
//  - checkKeyRateLimit: in-memory fixed-window RPM (resets on restart)
//  - checkDailyQuota:    persistent daily request cap (kvStore, resets at midnight)
// Both fail-open: disabled/unknown config → allowed.
import { createHash } from "node:crypto";
import { makeKv } from "./db/helpers/kvStore.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { sendNotification } from "./notifications.js";

// ─── Rate limit (fixed window, in-memory) ───────────────────────────────
const windows = new Map(); // key -> { start, count }

export function checkKeyRateLimit(key, { enabled, rpm = 60, windowMs = 60_000 } = {}) {
  if (!enabled || !key || !Number.isFinite(rpm) || rpm <= 0) {
    return { allowed: true, retryAfterSec: 0, remaining: Number.POSITIVE_INFINITY };
  }
  const now = Date.now();
  let w = windows.get(key);
  if (!w || now - w.start >= windowMs) {
    w = { start: now, count: 0 };
    windows.set(key, w);
  }
  if (w.count >= rpm) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((w.start + windowMs - now) / 1000)) };
  }
  w.count++;
  return { allowed: true, retryAfterSec: 0, remaining: rpm - w.count };
}

export function resetRateLimiter() {
  windows.clear();
}

// ─── Daily quota (persistent) ────────────────────────────────────────────
const quotaKv = makeKv("apiKeyQuota");

function quotaKey(key) {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const day = new Date().toISOString().slice(0, 10); // UTC day; kv is per-key anyway
  return `${day}:${hash}`;
}

export async function checkDailyQuota(key, { enabled, requests = 500 } = {}) {
  if (!enabled || !key || !Number.isFinite(requests) || requests <= 0) {
    return { allowed: true, used: 0, limit: requests };
  }
  const k = quotaKey(key);
  const used = (await quotaKv.get(k, 0)) || 0;
  if (used >= requests) return { allowed: false, used, limit: requests };
  await quotaKv.set(k, used + 1);
  return { allowed: true, used: used + 1, limit: requests };
}

// ─── Shared enforcement (chat, embeddings, images, …) ───────────────────
/**
 * Rate-limit + daily-quota gate for an API key. Fail-open.
 * @returns {{allowed:boolean, retryAfterSec?:number, reason?:string, used?:number, limit?:number}}
 */
export async function checkApiLimits(apiKey, settings = {}) {
  if (!apiKey) return { allowed: true };
  const rl = checkKeyRateLimit(apiKey, settings.apiKeyRateLimit || {});
  if (!rl.allowed) {
    sendNotification("api_key_limited", {
      apiKey: maskKey(apiKey), reason: "rate_limit", retryAfterSec: rl.retryAfterSec,
    });
    return { allowed: false, reason: "rate_limit", retryAfterSec: rl.retryAfterSec };
  }
  const quota = await checkDailyQuota(apiKey, settings.apiKeyDailyQuota || {});
  if (!quota.allowed) {
    sendNotification("api_key_limited", {
      apiKey: maskKey(apiKey), reason: "daily_quota", used: quota.used, limit: quota.limit,
    });
    return { allowed: false, reason: "daily_quota", retryAfterSec: 86400, used: quota.used, limit: quota.limit };
  }
  return { allowed: true };
}

/** 429 JSON response with Retry-After (mirrors OpenAI rate_limit_error shape). */
export function rateLimitResponse(retryAfterSec, message) {
  return new Response(
    JSON.stringify({ error: { message, type: "rate_limit_error", code: "rate_limit_exceeded" } }),
    {
      status: HTTP_STATUS.RATE_LIMITED,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Retry-After": String(retryAfterSec),
      },
    }
  );
}

/** "sk-***abc123" style masking for notification payloads. */
function maskKey(key) {
  if (!key) return "";
  return key.length <= 8 ? "***" : `${key.slice(0, 3)}***${key.slice(-6)}`;
}
