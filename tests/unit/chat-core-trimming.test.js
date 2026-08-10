import { describe, it, expect, vi, beforeEach } from "vitest";

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({
    noAuth: true,
    execute: executeMock,
  }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("../../open-sse/utils/stream.js", () => ({
  COLORS: { red: "", reset: "" },
  createPassthroughStreamWithLogger: vi.fn(() => new TransformStream()),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

function runChatCore(overrides = {}) {
  return handleChatCore({
    body: { model: "gpt-4o", stream: false, messages: overrides.messages || [] },
    modelInfo: { provider: "openai", model: "gpt-4o" },
    credentials: { apiKey: "test-key", providerSpecificData: {} },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), line: vi.fn() },
    connectionId: "test-conn",
    headroomEnabled: false,
    headroomUrl: "http://localhost:8787",
    headroomCompressUserMessages: false,
    settings: {
      headroomMinBytes: 0,
      dedupMessages: false,
      historyTrimMaxBytes: 0,
      historyTrimKeepMin: 6,
      summaryInject: false,
      summaryInjectAboveBytes: 90000,
      ...overrides.settings,
    },
    rtkEnabled: false,
    cavemanEnabled: false,
    cavemanLevel: "full",
    ponytailEnabled: false,
    ponytailLevel: "full",
    clientRawRequest: {
      endpoint: "/v1/chat/completions",
      body: {},
      headers: { accept: "application/json" },
    },
    ...overrides,
  });
}

function sentBody() {
  return executeMock.mock.calls.at(-1)[0].body;
}

describe("handleChatCore trimming savers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn(async () => {
      throw new Error("unexpected fetch");
    });
    executeMock.mockResolvedValue({
      response: new Response(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
      url: "https://api.openai.com/v1/chat/completions",
      headers: {},
      transformedBody: null,
    });
  });

  it("leaves body untouched when trim savers are off (default)", async () => {
    const messages = [
      { role: "user", content: "a" },
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ];
    await runChatCore({ messages });
    expect(sentBody().messages).toEqual(messages);
  });

  it("dedups consecutive identical messages when dedupMessages is on", async () => {
    await runChatCore({
      messages: [
        { role: "user", content: "a" },
        { role: "tool", content: "same" },
        { role: "tool", content: "same" },
        { role: "user", content: "next" },
      ],
      settings: { dedupMessages: true },
    });
    const body = sentBody();
    expect(body.messages).toHaveLength(3);
    expect(body.messages.filter((m) => m.content === "same")).toHaveLength(1);
  });

  it("trims oldest messages when historyTrimMaxBytes is set, keeps system + tail", async () => {
    await runChatCore({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "old one" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "new question" },
      ],
      settings: { historyTrimMaxBytes: 100, historyTrimKeepMin: 2 },
    });
    const body = sentBody();
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(body.messages.length).toBeLessThan(4);
    expect(body.messages.at(-1).content).toBe("new question");
  });

  it("injects heuristic summary when summaryInject kicks in", async () => {
    await runChatCore({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "question one" },
        { role: "assistant", content: "answer one" },
        { role: "user", content: "question two" },
        { role: "assistant", content: "answer two" },
        { role: "user", content: "current" },
        { role: "assistant", content: "answer current" },
        { role: "user", content: "final prompt" },
      ],
      settings: { summaryInject: true, summaryInjectAboveBytes: 1 },
    });
    const body = sentBody();
    const summaries = body.messages.filter((m) => m.role === "system" && m.content.includes("Conversation summary"));
    expect(summaries).toHaveLength(1);
    expect(summaries[0].content).toContain("question one");
    expect(body.messages.at(-1).content).toBe("final prompt");
    expect(body.messages.length).toBeLessThan(8);
  });

  it("plan savers override global toggles for trim features", async () => {
    await runChatCore({
      messages: [
        { role: "user", content: "x" },
        { role: "user", content: "x" },
        { role: "user", content: "y" },
      ],
      settings: { dedupMessages: false },
      preResolvedPlan: { planId: "p1", reason: "custom-plan", savers: { rtk: false, headroom: false, dedupMessages: true }, budgetTokens: null, degradeTo: null },
    });
    expect(sentBody().messages).toHaveLength(2);
  });
});
