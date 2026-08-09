// Per-API-key request throttling:
//  - checkKeyRateLimit: in-memory fixed-window RPM (resets on restart)
//  - checkDailyQuota:    persistent daily request cap (kvStore, resets at midnight)
// Both fail-open: disabled/unknown config → allowed.
import { createHash } from "node:crypto";
import { makeKv } from "./db/helpers/kvStore.js";

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
