// Budget guard: estimates request tokens and decides warn/degrade/block
// before compression runs. Pure sync; all limits come from settings.
import { estimateBodyBytes } from "./planner.js";

const BYTES_PER_TOKEN_ESTIMATE = 4; // ~4 bytes/token for mixed text+JSON

export function estimateRequestTokens(body) {
  const bytes = estimateBodyBytes(body);
  return Math.max(1, Math.round(bytes / BYTES_PER_TOKEN_ESTIMATE));
}

/**
 * ctx: { body, usedTodayTokens, model, plan (optional) }
 * settings: { tokenSaverBudget: { enabled, dailyTokens, warnThresholdPct, action } }
 * Returns { decision: "permit"|"warn"|"degrade"|"block", estimatedTokens, remainingTokens, reason }
 */
export function checkBudget(ctx, settings = {}) {
  const budget = settings.tokenSaverBudget || {};
  const estimated = estimateRequestTokens(ctx.body);

  if (!budget.enabled || !budget.dailyTokens) {
    return { decision: "permit", estimatedTokens: estimated, remainingTokens: null, reason: "budget-disabled" };
  }

  const daily = Number(budget.dailyTokens) || 0;
  const used = Math.max(0, Number(ctx.usedTodayTokens) || 0);
  const remaining = daily - used;

  if (estimated > remaining) {
    if (budget.action === "block") {
      return { decision: "block", estimatedTokens: estimated, remainingTokens: remaining, reason: "over-budget-block" };
    }
    return { decision: "degrade", estimatedTokens: estimated, remainingTokens: remaining, reason: "over-budget-degrade" };
  }

  const warnPct = Math.min(100, Number(budget.warnThresholdPct) || 80);
  if (used / daily >= warnPct / 100) {
    return { decision: "warn", estimatedTokens: estimated, remainingTokens: remaining, reason: "near-budget-warn" };
  }

  return { decision: "permit", estimatedTokens: estimated, remainingTokens: remaining, reason: "within-budget" };
}

/**
 * Suggest a cheaper model when budget is tight. Uses plan.degradeTo if set,
 * else a static fallback map keyed by model name substring.
 */
export function suggestDegrade(model, plan = null) {
  if (plan?.degradeTo) return plan.degradeTo;
  if (!model || typeof model !== "string") return null;
  const m = model.toLowerCase();
  const FALLBACKS = [
    [/gpt-4(\.\d|-turbo)?/i, "gpt-4o-mini"],
    [/claude-(sonnet|opus)/i, "claude-3-5-haiku"],
    [/gemini-(1\.5-)?pro/i, "gemini-1.5-flash"],
    [/deepseek-(reasoner|chat)/i, "deepseek-chat"],
  ];
  for (const [re, replacement] of FALLBACKS) {
    if (re.test(m)) return replacement;
  }
  return null;
}
