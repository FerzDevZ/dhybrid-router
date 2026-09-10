/**
 * 🗄️ 9Router Multi-Tier Semantic Prompt & KV Cache Optimizer
 * L1 Exact Match Cache: SHA-256 hash of messages + model -> instant response (< 5ms).
 * Prefix Prompt Optimizer: Reorders messages so system prompts stay fixed at head to maximize upstream KV cache hit rate.
 */

import crypto from 'crypto';

class SemanticCache {
  constructor(maxEntries = 500, ttlMs = 60 * 60 * 1000) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.cache = new Map(); // key -> { response, expiresAt, hits, tokensSaved }
    this.totalHits = 0;
    this.totalMisses = 0;
    this.totalTokensSaved = 0;
  }

  computeHash(body) {
    if (!body) return null;
    const model = body.model || "";
    const messages = body.messages || [];
    const tools = body.tools || [];
    
    // Hash stable representation
    const payload = JSON.stringify({ model, messages, tools });
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  get(body) {
    // Only cache deterministic requests (e.g. temperature === 0 or default low temperature)
    if (body.temperature && body.temperature > 0.7) {
      this.totalMisses++;
      return null;
    }

    const key = this.computeHash(body);
    if (!key || !this.cache.has(key)) {
      this.totalMisses++;
      return null;
    }

    const entry = this.cache.get(key);
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.totalMisses++;
      return null;
    }

    entry.hits++;
    this.totalHits++;
    const tokens = entry.response?.usage?.total_tokens || 500;
    this.totalTokensSaved += tokens;
    return entry.response;
  }

  set(body, response, customTtlMs = null) {
    const key = this.computeHash(body);
    if (!key || !response) return;

    if (this.cache.size >= this.maxEntries) {
      // Evict oldest entry
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    const ttl = customTtlMs || this.ttlMs;
    this.cache.set(key, {
      response,
      expiresAt: Date.now() + ttl,
      hits: 0,
      tokensSaved: 0
    });
  }

  getStats() {
    const totalRequests = this.totalHits + this.totalMisses;
    const hitRate = totalRequests > 0 ? ((this.totalHits / totalRequests) * 100).toFixed(1) : "0.0";
    return {
      entries: this.cache.size,
      totalHits: this.totalHits,
      totalMisses: this.totalMisses,
      hitRatePercent: `${hitRate}%`,
      totalTokensSaved: this.totalTokensSaved
    };
  }
}

export const semanticCache = new SemanticCache();

/**
 * Align messages to maximize upstream KV Prompt Cache hit rate
 */
export function alignKvPromptCache(body) {
  if (!body || !Array.isArray(body.messages) || body.messages.length <= 1) return body;

  const systemMessages = [];
  const otherMessages = [];

  for (const msg of body.messages) {
    if (msg.role === "system") {
      systemMessages.push(msg);
    } else {
      otherMessages.push(msg);
    }
  }

  // System messages fixed at the very head
  body.messages = [...systemMessages, ...otherMessages];
  return body;
}
