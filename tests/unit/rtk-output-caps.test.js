import { describe, it, expect } from "vitest";
import { estimateOutputTokens, capOutputTokens } from "../../open-sse/rtk/outputCaps.js";

describe("estimateOutputTokens", () => {
  it("short text prompt → 1024", () => {
    expect(estimateOutputTokens({ messages: [{ role: "user", content: "hi" }] })).toBe(1024);
  });

  it("code prompt → 4096", () => {
    const body = { messages: [{ role: "user", content: "refactor this:\nfunction foo() {\n  return 1;\n}" }] };
    expect(estimateOutputTokens(body)).toBe(4096);
  });

  it("long text prompt (>1200 chars) → 4096", () => {
    expect(estimateOutputTokens({ messages: [{ role: "user", content: "a".repeat(1500) }] })).toBe(4096);
  });

  it("unknown shape → safe default", () => {
    expect(estimateOutputTokens({ contents: [] })).toBe(1024);
    expect(estimateOutputTokens(null)).toBe(1024);
  });
});

describe("capOutputTokens", () => {
  it("sets max_tokens when absent (chat shape)", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const stats = capOutputTokens(body, true);
    expect(stats).not.toBeNull();
    expect(body.max_tokens).toBe(1024);
  });

  it("sets max_output_tokens for responses shape", () => {
    const body = { input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] };
    capOutputTokens(body, true);
    expect(body.max_output_tokens).toBe(1024);
  });

  it("lowers absurdly large max_tokens", () => {
    const body = { messages: [{ role: "user", content: "hi" }], max_tokens: 32000 };
    const stats = capOutputTokens(body, true);
    expect(stats.savedTokens).toBeGreaterThan(0);
    expect(body.max_tokens).toBe(1024);
  });

  it("respects small explicit values (user intent wins)", () => {
    const body = { messages: [{ role: "user", content: "hi" }], max_tokens: 256 };
    expect(capOutputTokens(body, true)).toBeNull();
    expect(body.max_tokens).toBe(256);
  });

  it("never touches reasoning_effort or thinking", () => {
    const body = { messages: [{ role: "user", content: "hi" }], max_tokens: 32000, reasoning_effort: "high", thinking: { type: "enabled", budget_tokens: 16000 } };
    capOutputTokens(body, true);
    expect(body.reasoning_effort).toBe("high");
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 16000 });
  });

  it("disabled → null, fail-open on unknown shape", () => {
    expect(capOutputTokens({ messages: [{ role: "user", content: "hi" }] }, false)).toBeNull();
    expect(capOutputTokens(null, true)).toBeNull();
    expect(capOutputTokens({ contents: [] }, true)).toBeNull();
  });
});
