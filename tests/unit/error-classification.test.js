// A3: permanent-error classification — client/model faults must NOT trigger
// account fallback or locking; transient errors keep fallback semantics.
import { describe, it, expect } from "vitest";
import { checkFallbackError } from "../../open-sse/services/accountFallback.js";

describe("checkFallbackError — permanent classification", () => {
  it("400/404/406 are permanent (no fallback, no lock)", () => {
    for (const status of [400, 404, 406]) {
      const r = checkFallbackError(status, "some upstream message");
      expect(r.shouldFallback).toBe(false);
      expect(r.permanent).toBe(true);
      expect(r.cooldownMs).toBe(0);
    }
  });

  it("model-not-found text is permanent", () => {
    const r = checkFallbackError(500, "The model 'gpt-5' was not found");
    expect(r.permanent).toBe(true);
    expect(r.shouldFallback).toBe(false);
  });

  it("401 keeps account-level fallback (different accounts may still work)", () => {
    const r = checkFallbackError(401, "invalid api key");
    expect(r.shouldFallback).toBe(true);
    expect(r.permanent).toBeUndefined();
    expect(r.cooldownMs).toBeGreaterThan(0);
  });

  it("429 rate limit keeps exponential backoff", () => {
    const r = checkFallbackError(429, "rate limit reached");
    expect(r.shouldFallback).toBe(true);
    expect(r.newBackoffLevel).toBe(1);
  });

  it("unmatched errors keep transient fallback", () => {
    const r = checkFallbackError(502, "Bad Gateway");
    expect(r.shouldFallback).toBe(true);
    expect(r.permanent).toBeUndefined();
    expect(r.cooldownMs).toBe(30_000);
  });
});
