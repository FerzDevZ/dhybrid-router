import { describe, it, expect } from "vitest";
import { planTokenSaver, PLAN_MATCH_NONE, estimateBodyBytes } from "@/lib/tokenSaver/planner.js";
import { checkBudget, suggestDegrade } from "@/lib/tokenSaver/budgetGuard.js";

describe("token saver planner", () => {
  it("matches custom plan by model regex + min payload", () => {
    const plan = planTokenSaver(
      { provider: "openai", model: "gpt-4o", body: { messages: [{ role: "user", content: "x".repeat(100000) }] } },
      { tokenSaverPlans: [{ id: "big-gpt", modelRegex: "gpt-4", minPayloadBytes: 5000, savers: { rtk: true, headroom: false } }] }
    );
    expect(plan.planId).toBe("big-gpt");
    expect(plan.savers).toEqual({ rtk: true, headroom: false });
  });

  it("ignores plan when payload below threshold", () => {
    const plan = planTokenSaver(
      { provider: "openai", model: "gpt-4o", body: { messages: [{ role: "user", content: "hi" }] } },
      { tokenSaverPlans: [{ id: "big-gpt", modelRegex: "gpt-4", minPayloadBytes: 5000, savers: { rtk: true } }] }
    );
    expect(plan.planId).toBe(PLAN_MATCH_NONE);
    expect(plan.savers).toBeNull();
  });

  it("falls back to none (global) when no plans configured", () => {
    const plan = planTokenSaver({ provider: "anthropic", model: "claude-3", body: { messages: [] } }, {});
    expect(plan.planId).toBe(PLAN_MATCH_NONE);
    expect(plan.reason).toBe("default");
  });

  it("safeRegex never throws on garbage patterns", () => {
    const plan = planTokenSaver(
      { provider: "x", model: "m", body: { messages: [] } },
      { tokenSaverPlans: [{ id: "bad", modelRegex: "*bad-pattern", savers: { rtk: true } }] }
    );
    expect(plan.planId).toBe(PLAN_MATCH_NONE);
  });

  it("estimates body bytes from JSON", () => {
    const bytes = estimateBodyBytes({ a: [1, 2, 3], s: "hello" });
    expect(bytes).toBeGreaterThan(10);
  });
});

describe("budget guard", () => {
  it("permits when disabled", () => {
    const r = checkBudget({ body: { messages: [] }, usedTodayTokens: 1000 }, {});
    expect(r.decision).toBe("permit");
    expect(r.reason).toBe("budget-disabled");
  });

  it("blocks when request exceeds remaining", () => {
    const r = checkBudget(
      { body: { messages: [{ content: "x".repeat(8000) }] }, usedTodayTokens: 5000 },
      { tokenSaverBudget: { enabled: true, dailyTokens: 6000, action: "block" } }
    );
    expect(r.decision).toBe("block");
    expect(r.remainingTokens).toBe(1000);
  });

  it("degrades (not blocks) when action is degrade", () => {
    const r = checkBudget(
      { body: { messages: [{ content: "x".repeat(8000) }] }, usedTodayTokens: 5000 },
      { tokenSaverBudget: { enabled: true, dailyTokens: 6000, action: "degrade" } }
    );
    expect(r.decision).toBe("degrade");
  });

  it("warns near threshold, permits otherwise", () => {
    const base = { enabled: true, dailyTokens: 10000, action: "warn" };
    const near = checkBudget({ body: { messages: [{ content: "hi" }] }, usedTodayTokens: 8500 }, { tokenSaverBudget: base });
    expect(near.decision).toBe("warn");
    const ok = checkBudget({ body: { messages: [{ content: "hi" }] }, usedTodayTokens: 100 }, { tokenSaverBudget: base });
    expect(ok.decision).toBe("permit");
  });

  it("suggests cheaper model", () => {
    expect(suggestDegrade("gpt-4-turbo")).toBe("gpt-4o-mini");
    expect(suggestDegrade("claude-sonnet-4-5")).toBe("claude-3-5-haiku");
    expect(suggestDegrade("unknown-model")).toBeNull();
    expect(suggestDegrade("gpt-4o", { degradeTo: "custom-cheap" })).toBe("custom-cheap");
  });
});
