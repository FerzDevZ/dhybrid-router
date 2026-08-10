// Exact-match response cache for non-stream chat completions.
// LRU eviction + TTL. Keyed by canonical hash of {endpoint, model, messages,
// tools, params} — byte-for-byte matching only (no fuzzy hits, no stale data).
// In-memory only (server-local); entries are cheap JSON strings.
import { createHash } from "node:crypto";

const store = new Map(); // key → { payload, expiresAt }
let hits = 0;
let misses = 0;

function hashKey(parts) {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest("hex");
}

/**
 * Build the cache key for a chat request. Returns null when the request must
 * never be cached (streaming, no messages, invalid body).
 */
export function responseCacheKey({ endpoint, provider, model, body }) {
  if (!body || typeof body !== "object") return null;
  if (body.stream === true) return null;
  if (!Array.isArray(body.messages) || body.messages.length === 0) return null;

  const canonical = {
    endpoint: endpoint || "/v1/chat/completions",
    model: `${provider}/${model}`,
    messages: body.messages,
    tools: body.tools || null,
    tool_choice: body.tool_choice || null,
    temperature: body.temperature ?? null,
    top_p: body.top_p ?? null,
    max_tokens: body.max_tokens ?? null,
    max_output_tokens: body.max_output_tokens ?? null,
  };
  return hashKey([JSON.stringify(canonical)]);
}

export function responseCacheGet(key) {
  const entry = store.get(key);
  if (!entry) {
    misses++;
    return null;
  }
  if (Date.now() >= entry.expiresAt) {
    store.delete(key);
    misses++;
    return null;
  }
  // LRU touch
  store.delete(key);
  store.set(key, entry);
  hits++;
  return entry.payload;
}

export function responseCacheSet(key, payload, ttlMs) {
  if (!key) return;
  store.set(key, { payload, expiresAt: Date.now() + ttlMs });
  trimToMax();
}

function trimToMax() {
  // Simple LRU trim: evict oldest-inserted (Map insertion order) beyond cap.
  // Callers pass maxEntries via setter below; default 200.
  while (store.size > maxEntries) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

let maxEntries = 200;
export function responseCacheSetMax(n) {
  if (Number.isFinite(n) && n > 0) {
    maxEntries = Math.floor(n);
    trimToMax();
  }
}

export function responseCacheClear() {
  store.clear();
  hits = 0;
  misses = 0;
}

export function responseCacheStats() {
  return { entries: store.size, maxEntries, hits, misses };
}
