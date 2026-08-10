// B1: adaptive account scoring — success/fail learning with neutral baseline
// until 5 samples, then raw success rate.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-score-"));
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

describe("adaptive account score", () => {
  it("neutral 0.5 before 5 samples", async () => {
    const auth = await import("../../src/sse/services/auth.js");
    const s = await auth.getAccountScore("acc-neut");
    expect(s.score).toBe(0.5);
    expect(s.samples).toBe(0);
  });

  it("records success and fail, then reflects success rate", async () => {
    const auth = await import("../../src/sse/services/auth.js");
    await auth.recordAccountSuccess("acc-mix");
    await auth.recordAccountSuccess("acc-mix");
    await auth.recordAccountSuccess("acc-mix");
    const before = await auth.getAccountScore("acc-mix");
    expect(before.score).toBe(0.5); // still < 5 samples

    await auth.recordAccountSuccess("acc-mix");
    await auth.recordAccountSuccess("acc-mix");
    const clean = await auth.getAccountScore("acc-mix");
    expect(clean.score).toBe(1);
    expect(clean.samples).toBe(5);

    await auth.recordAccountFail("acc-mix");
    const mixed = await auth.getAccountScore("acc-mix");
    expect(mixed.score).toBe(5 / 6);
    expect(mixed.samples).toBe(6);
    expect(mixed.lastSuccessAt).toBeGreaterThan(0);
  });

  it("persists across module reload", async () => {
    const auth = await import("../../src/sse/services/auth.js");
    await auth.recordAccountSuccess("acc-persist");
    await auth.recordAccountSuccess("acc-persist");
    await auth.recordAccountSuccess("acc-persist");
    await auth.recordAccountSuccess("acc-persist");
    await auth.recordAccountSuccess("acc-persist");
    vi.resetModules();
    const auth2 = await import("../../src/sse/services/auth.js");
    const s = await auth2.getAccountScore("acc-persist");
    expect(s.score).toBe(1);
  });

  it("records latency and exposes rolling average", async () => {
    const auth = await import("../../src/sse/services/auth.js");
    await auth.recordAccountSuccess("acc-lat");
    await auth.recordAccountLatency("acc-lat", 100);
    await auth.recordAccountLatency("acc-lat", 300);
    const s = await auth.getAccountScore("acc-lat");
    expect(s.avgLatency).toBe(200);
    expect(s.latencySamples).toBe(2);
  });

  it("ignores invalid latency inputs (fail-safe)", async () => {
    const auth = await import("../../src/sse/services/auth.js");
    await auth.recordAccountLatency("acc-lat2", -5);
    await auth.recordAccountLatency("acc-lat2", NaN);
    await auth.recordAccountLatency("", 100);
    const s = await auth.getAccountScore("acc-lat2");
    expect(s.latencySamples).toBe(0);
    expect(s.avgLatency).toBe(0);
  });
});
