/**
 * ⚡ 9Router Adaptive Concurrency & QoS Token-Bucket Queue
 * Manages per-provider concurrency slots and rate-limiting queues.
 * Prevents 429 Too Many Requests by scheduling requests smoothly with burst dampening.
 */

class TokenBucket {
  constructor(capacity = 20, refillRatePerSec = 5) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillRatePerSec;
    this.lastRefill = Date.now();
  }

  refill() {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillRate);
    this.lastRefill = now;
  }

  tryConsume(cost = 1) {
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  getWaitMs(cost = 1) {
    this.refill();
    if (this.tokens >= cost) return 0;
    const deficit = cost - this.tokens;
    return Math.ceil((deficit / this.refillRate) * 1000);
  }
}

class ProviderQoSQueue {
  constructor(providerName, maxConcurrency = 8) {
    this.providerName = providerName;
    this.maxConcurrency = maxConcurrency;
    this.activeRequests = 0;
    this.bucket = new TokenBucket(15, 4);
    this.queue = [];
  }

  async acquire(priority = 1) {
    // If bucket has tokens and concurrency is within bounds, execute immediately
    if (this.activeRequests < this.maxConcurrency && this.bucket.tryConsume(1)) {
      this.activeRequests++;
      return;
    }

    // Otherwise, wait in priority queue
    return new Promise((resolve) => {
      const waitMs = this.bucket.getWaitMs(1);
      const entry = { priority, resolve, waitMs };
      
      if (priority === 1) {
        // High priority: insert at front
        this.queue.unshift(entry);
      } else {
        this.queue.push(entry);
      }

      setTimeout(() => {
        this.processQueue();
      }, Math.max(waitMs, 50));
    });
  }

  release() {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.processQueue();
  }

  processQueue() {
    if (this.queue.length === 0 || this.activeRequests >= this.maxConcurrency) return;

    if (this.bucket.tryConsume(1)) {
      const next = this.queue.shift();
      if (next) {
        this.activeRequests++;
        next.resolve();
      }
    }
  }
}

const providerQueues = new Map();

export function getProviderQueue(provider) {
  const p = provider || "default";
  if (!providerQueues.has(p)) {
    const concurrency = p.includes("grok") ? 6 : p.includes("cf") ? 12 : 8;
    providerQueues.set(p, new ProviderQoSQueue(p, concurrency));
  }
  return providerQueues.get(p);
}

export async function withQoS(provider, fn, priority = 1) {
  const queue = getProviderQueue(provider);
  await queue.acquire(priority);
  try {
    return await fn();
  } finally {
    queue.release();
  }
}

export function getQueueStats() {
  const stats = {};
  for (const [name, q] of providerQueues.entries()) {
    stats[name] = {
      activeRequests: q.activeRequests,
      queueDepth: q.queue.length,
      availableTokens: Math.floor(q.bucket.tokens)
    };
  }
  return stats;
}
