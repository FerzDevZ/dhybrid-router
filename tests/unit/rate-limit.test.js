// A1/A2: per-key rate limit (RPM window) + daily quota (kv-persisted) + notifications throttle
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-ratelimit-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  const db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("checkKeyRateLimit (fixed window)", () => {
  it("allows up to rpm, blocks beyond, with retry-after", async () => {
    const rl = await import("@/lib/rateLimit.js");
    rl.resetRateLimiter();
    const cfg = { enabled: true, rpm: 2 };
    expect(rl.checkKeyRateLimit("k1", cfg).allowed).toBe(true);
    expect(rl.checkKeyRateLimit("k1", cfg).allowed).toBe(true);
    const blocked = rl.checkKeyRateLimit("k1", cfg);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
    // other key unaffected
    expect(rl.checkKeyRateLimit("k2", cfg).allowed).toBe(true);
  });

  it("window expiry resets the counter", async () => {
    vi.useFakeTimers();
    try {
      const rl = await import("@/lib/rateLimit.js");
      rl.resetRateLimiter();
      const cfg = { enabled: true, rpm: 1, windowMs: 1000 };
      expect(rl.checkKeyRateLimit("k3", cfg).allowed).toBe(true);
      expect(rl.checkKeyRateLimit("k3", cfg).allowed).toBe(false);
      vi.advanceTimersByTime(1001);
      expect(rl.checkKeyRateLimit("k3", cfg).allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fail-open when disabled or missing key", async () => {
    const rl = await import("@/lib/rateLimit.js");
    rl.resetRateLimiter();
    expect(rl.checkKeyRateLimit("k", { enabled: false, rpm: 1 }).allowed).toBe(true);
    expect(rl.checkKeyRateLimit(null, { enabled: true, rpm: 1 }).allowed).toBe(true);
  });
});

describe("checkDailyQuota (persistent)", () => {
  it("blocks after daily cap and persists across module reload", async () => {
    const rl = await import("@/lib/rateLimit.js");
    const cfg = { enabled: true, requests: 3 };
    for (let i = 0; i < 3; i++) {
      expect((await rl.checkDailyQuota("qkey", cfg)).allowed).toBe(true);
    }
    const blocked = await rl.checkDailyQuota("qkey", cfg);
    expect(blocked.allowed).toBe(false);
    expect(blocked.used).toBe(3);
    expect(blocked.limit).toBe(3);

    // persisted in kv → still blocked after reload
    vi.resetModules();
    const rl2 = await import("@/lib/rateLimit.js");
    expect((await rl2.checkDailyQuota("qkey", cfg)).allowed).toBe(false);
  });

  it("fail-open when disabled", async () => {
    const rl = await import("@/lib/rateLimit.js");
    expect((await rl.checkDailyQuota("qkey2", { enabled: false, requests: 1 })).allowed).toBe(true);
  });
});

describe("sendNotification", () => {
  it("posts webhook once per (event, scope) within throttle, different scopes pass", async () => {
    const calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, opts) => { calls.push({ url, opts }); return new Response("ok"); }));
    vi.resetModules();
    process.env.NOTIFICATION_WEBHOOK_URL = "https://hooks.example.com/9r";
    process.env.NOTIFICATION_MIN_INTERVAL_MS = "60000";
    const notif = await import("@/lib/notifications.js");

    await notif.sendNotification("account_locked", { provider: "openai", connectionId: "c1" });
    await notif.sendNotification("account_locked", { provider: "openai", connectionId: "c1" }); // throttled
    await notif.sendNotification("account_locked", { provider: "openai", connectionId: "c2" }); // different scope
    await notif.sendNotification("api_key_limited", { apiKey: "sk-***" }); // different event

    expect(calls.length).toBe(3);
    expect(JSON.parse(calls[0].opts.body).event).toBe("account_locked");
    expect(calls[0].url).toBe("https://hooks.example.com/9r");
    vi.unstubAllGlobals();
    delete process.env.NOTIFICATION_WEBHOOK_URL;
    delete process.env.NOTIFICATION_MIN_INTERVAL_MS;
  });

  it("no-op without webhook url", async () => {
    vi.resetModules();
    delete process.env.NOTIFICATION_WEBHOOK_URL;
    const notif = await import("@/lib/notifications.js");
    await notif.sendNotification("x", {});
    expect(notif.getNotificationWebhookUrl()).toBe("");
  });
});
