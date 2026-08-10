// Token Saver planner: decides WHICH savers apply to a request based on
// (provider, model, request format, payload size) using user-defined plans
// (settings.tokenSaverPlans). Falls back to global toggles when no plan
// matches. Pure + sync → unit-testable without DB.
import { detectFormatByEndpoint, FORMATS } from "../../../open-sse/translator/formats.js";
import { estimateRequestTokens } from "./budgetGuard.js";

export const PLAN_MATCH_NONE = "none";

// When a plan carries a per-request token budget, requests above it get the
// aggressive saver treatment (rtk+headroom+caveman forced on). Pure check —
// chatCore decides what to enable and records the decision in events.
export function enforcePlanBudget(plan, body) {
  if (!plan || typeof plan.budgetTokens !== "number" || plan.budgetTokens <= 0) {
    return { overBudget: false, estimatedTokens: null };
  }
  const estimatedTokens = estimateRequestTokens(body);
  return { overBudget: estimatedTokens > plan.budgetTokens, estimatedTokens };
}

// Small helpers kept here so callers (chatCore, tests) don't need to know
// the matching internals.
export function matchesPlan(plan, ctx) {
  if (!plan || typeof plan !== "object") return false;
  if (plan.modelRegex) {
    const re = safeRegex(plan.modelRegex);
    if (!re) return false; // invalid pattern → never match
    if (!re.test(String(ctx.model || ""))) return false;
  }
  if (plan.provider) {
    const p = String(ctx.provider || "").toLowerCase();
    if (p !== String(plan.provider).toLowerCase()) return false;
  }
  if (plan.format) {
    const f = String(ctx.format || "");
    if (f !== String(plan.format)) return false;
  }
  if (plan.minPayloadBytes && (ctx.payloadBytes || 0) < plan.minPayloadBytes) return false;
  return true;
}

export function safeRegex(pattern) {
  if (!pattern || typeof pattern !== "string") return null;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

/**
 * Compute the effective saver plan for a request.
 * ctx: { provider, model, format?, payloadBytes, body }
 * Returns { planId, reason, savers, budgetTokens, degradeTo } where savers is
 * { rtk, headroom, pxpipe, caveman, ponytail } booleans — null when inheriting
 * global settings.
 */
export function planTokenSaver(ctx, settings = {}) {
  const plans = Array.isArray(settings.tokenSaverPlans) ? settings.tokenSaverPlans : [];
  const format = ctx.format || detectFormatByEndpoint(ctx.pathname || "", ctx.body) || FORMATS.OPENAI;
  const payloadBytes = ctx.payloadBytes ?? estimateBodyBytes(ctx.body);

  for (const plan of plans) {
    if (!matchesPlan(plan, { ...ctx, format, payloadBytes })) continue;
    return {
      planId: plan.id || "custom",
      reason: "custom-plan",
      savers: normalizeSavers(plan.savers),
      budgetTokens: plan.budgetTokens ?? null,
      degradeTo: plan.degradeTo || null,
    };
  }

  return {
    planId: PLAN_MATCH_NONE,
    reason: "default",
    savers: null, // inherit global toggles
    budgetTokens: null,
    degradeTo: null,
  };
}

function normalizeSavers(savers) {
  if (!savers || typeof savers !== "object") return null;
  const out = {};
  for (const k of ["rtk", "headroom", "pxpipe", "caveman", "ponytail", "dedupMessages", "historyTrim", "summaryInject"]) {
    if (typeof savers[k] === "boolean") out[k] = savers[k];
  }
  return Object.keys(out).length ? out : null;
}

export function estimateBodyBytes(body) {
  try {
    return new TextEncoder().encode(JSON.stringify(body) || "").length;
  } catch {
    return 0;
  }
}
