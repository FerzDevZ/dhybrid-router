import { describe, it, expect } from "vitest";
import { dedupMessages, trimHistory, injectConversationSummary } from "../../open-sse/rtk/trimming.js";

function msg(role, content) {
  return { role, content };
}

describe("dedupMessages", () => {
  it("drops consecutive identical messages", () => {
    const body = {
      messages: [
        msg("user", "hi"),
        msg("tool", "same output"),
        msg("tool", "same output"),
        msg("user", "hello"),
      ],
    };
    const stats = dedupMessages(body);
    expect(stats).not.toBeNull();
    expect(stats.removed).toBe(1);
    expect(body.messages).toHaveLength(3);
    expect(body.messages[1].content).toBe("same output");
    expect(body.messages[2].content).toBe("hello");
  });

  it("keeps non-consecutive duplicates", () => {
    const body = {
      messages: [msg("user", "a"), msg("user", "b"), msg("user", "a")],
    };
    expect(dedupMessages(body)).toBeNull();
    expect(body.messages).toHaveLength(3);
  });

  it("returns null for unknown shapes (fail-open)", () => {
    expect(dedupMessages({ contents: [] })).toBeNull();
    expect(dedupMessages(null)).toBeNull();
    expect(dedupMessages({ messages: [msg("user", "x")] })).toBeNull();
  });

  it("works on OpenAI Responses input arrays", () => {
    const body = {
      input: [
        { type: "function_call_output", output: "dup" },
        { type: "function_call_output", output: "dup" },
      ],
    };
    const stats = dedupMessages(body);
    expect(stats.removed).toBe(1);
    expect(body.input).toHaveLength(1);
  });
});

describe("trimHistory", () => {
  it("drops oldest messages until under the cap, keeps system + tail", () => {
    const body = {
      messages: [
        msg("system", "sys"),
        msg("user", "old1"),
        msg("assistant", "a1"),
        msg("user", "old2"),
        msg("assistant", "a2"),
        msg("user", "new"),
      ],
    };
    // Cap small enough that only the last two messages fit.
    const stats = trimHistory(body, 40, 2);
    expect(stats).not.toBeNull();
    expect(stats.removed).toBeGreaterThan(0);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages.at(-1).content).toBe("new");
    expect(body.messages).toHaveLength(3);
  });

  it("off when maxBytes <= 0", () => {
    const body = { messages: [msg("user", "x"), msg("user", "y")] };
    expect(trimHistory(body, 0, 2)).toBeNull();
    expect(body.messages).toHaveLength(2);
  });

  it("no-op when already under cap", () => {
    const body = { messages: [msg("user", "tiny"), msg("user", "tiny2")] };
    expect(trimHistory(body, 1000000, 2)).toBeNull();
  });

  it("fails open on unknown shape", () => {
    expect(trimHistory({ contents: [] }, 10, 2)).toBeNull();
    expect(trimHistory(null, 10, 2)).toBeNull();
  });
});

describe("injectConversationSummary", () => {
  it("collapses middle messages into one system summary, keeps last 3", () => {
    const body = {
      messages: [
        msg("system", "sys"),
        msg("user", "question one"),
        msg("assistant", "answer one"),
        msg("user", "question two"),
        msg("assistant", "answer two"),
        msg("user", "current question"),
        msg("assistant", "current answer"),
        msg("user", "final prompt"),
      ],
    };
    const stats = injectConversationSummary(body, 1); // tiny threshold → always over
    expect(stats).not.toBeNull();
    expect(stats.removed).toBeGreaterThan(0);
    // system + summary + last 3
    expect(body.messages).toHaveLength(5);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1].role).toBe("system");
    expect(body.messages[1].content).toContain("question one");
    expect(body.messages[1].content).toContain("question two");
    expect(body.messages.at(-1).content).toBe("final prompt");
  });

  it("no-op when under threshold", () => {
    const body = {
      messages: Array.from({ length: 8 }, (_, i) => msg(i % 2 ? "assistant" : "user", `m${i}`)),
    };
    expect(injectConversationSummary(body, 1000000)).toBeNull();
    expect(body.messages).toHaveLength(8);
  });

  it("fails open on unknown shape / too-short history", () => {
    expect(injectConversationSummary({ contents: [] }, 1)).toBeNull();
    const short = { messages: [msg("user", "a"), msg("assistant", "b"), msg("user", "c")] };
    expect(injectConversationSummary(short, 1)).toBeNull();
    expect(short.messages).toHaveLength(3);
  });
});
