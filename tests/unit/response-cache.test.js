import { describe, it, expect, beforeEach } from "vitest";
import { responseCacheKey, responseCacheGet, responseCacheSet, responseCacheClear, responseCacheStats, responseCacheSetMax } from "../../src/lib/responseCache.js";

const BODY = {
  model: "gpt-4o",
  stream: false,
  messages: [{ role: "user", content: "hi" }],
};

describe("responseCacheKey", () => {
  beforeEach(() => responseCacheClear());

  it("stable key for identical requests", () => {
    const k1 = responseCacheKey({ endpoint: "/v1/chat/completions", provider: "openai", model: "gpt-4o", body: BODY });
    const k2 = responseCacheKey({ endpoint: "/v1/chat/completions", provider: "openai", model: "gpt-4o", body: BODY });
    expect(k1).toBe(k2);
  });

  it("differs when messages or model change", () => {
    const base = responseCacheKey({ endpoint: "/v1/chat/completions", provider: "openai", model: "gpt-4o", body: BODY });
    const otherMsg = responseCacheKey({ endpoint: "/v1/chat/completions", provider: "openai", model: "gpt-4o", body: { ...BODY, messages: [{ role: "user", content: "bye" }] } });
    const otherModel = responseCacheKey({ endpoint: "/v1/chat/completions", provider: "openai", model: "gpt-4o-mini", body: BODY });
    expect(base).not.toBe(otherMsg);
    expect(base).not.toBe(otherModel);
  });

  it("never caches streaming or tool-less invalid bodies", () => {
    expect(responseCacheKey({ endpoint: "/v1/chat/completions", provider: "openai", model: "gpt-4o", body: { ...BODY, stream: true } })).toBeNull();
    expect(responseCacheKey({ endpoint: "/v1/chat/completions", provider: "openai", model: "gpt-4o", body: { messages: [] } })).toBeNull();
    expect(responseCacheKey({ endpoint: "/v1/chat/completions", provider: "openai", model: "gpt-4o", body: null })).toBeNull();
  });
});

describe("responseCacheGet/Set", () => {
  beforeEach(() => responseCacheClear());

  it("stores and returns payload within TTL", () => {
    const key = responseCacheKey({ endpoint: "/v1/chat/completions", provider: "openai", model: "gpt-4o", body: BODY });
    responseCacheSet(key, { response: { choices: [{ message: { content: "ok" } }] } }, 300000);
    const got = responseCacheGet(key);
    expect(got).toEqual({ response: { choices: [{ message: { content: "ok" } }] } });
    expect(responseCacheStats().hits).toBe(1);
  });

  it("expires after TTL", async () => {
    const key = responseCacheKey({ endpoint: "/v1/chat/completions", provider: "openai", model: "gpt-4o", body: BODY });
    responseCacheSet(key, { response: "x" }, 10);
    await new Promise((r) => setTimeout(r, 30));
    expect(responseCacheGet(key)).toBeNull();
    expect(responseCacheStats().entries).toBe(0);
  });

  it("LRU evicts beyond maxEntries", () => {
    responseCacheSetMax(3);
    const keys = [];
    for (let i = 0; i < 5; i++) {
      const body = { ...BODY, messages: [{ role: "user", content: `msg${i}` }] };
      const k = responseCacheKey({ endpoint: "/v1/chat/completions", provider: "openai", model: "gpt-4o", body });
      keys.push(k);
      responseCacheSet(k, { response: i }, 300000);
    }
    expect(responseCacheStats().entries).toBe(3);
    expect(responseCacheGet(keys[0])).toBeNull(); // oldest evicted
    expect(responseCacheGet(keys[4])).not.toBeNull();
  });
});
