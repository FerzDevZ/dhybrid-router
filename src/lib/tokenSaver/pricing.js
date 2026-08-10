// Rough USD pricing per 1M tokens for popular models, used to estimate how
// much money the token savers save (dashboard). Fallbacks keep unknown models
// from breaking the estimate.
const PRICING = {
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4.1": { in: 2, out: 8 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  "gpt-4": { in: 30, out: 60 },
  "gpt-4-turbo": { in: 10, out: 30 },
  "o3-mini": { in: 1.1, out: 4.4 },
  "o4-mini": { in: 1.1, out: 4.4 },
  "claude-sonnet": { in: 3, out: 15 },
  "claude-sonnet-4-5": { in: 3, out: 15 },
  "claude-opus": { in: 15, out: 75 },
  "claude-haiku": { in: 0.8, out: 4 },
  "claude-3-5-haiku": { in: 0.8, out: 4 },
  "claude-3-haiku": { in: 0.25, out: 1.25 },
  "gemini-1.5-pro": { in: 1.25, out: 5 },
  "gemini-1.5-flash": { in: 0.075, out: 0.3 },
  "gemini-2.0-flash": { in: 0.1, out: 0.4 },
  "deepseek-chat": { in: 0.27, out: 1.1 },
  "deepseek-reasoner": { in: 0.55, out: 2.19 },
  "mistral-large": { in: 2, out: 6 },
  "llama-3.1-8b": { in: 0.05, out: 0.05 },
  "llama-3.1-70b": { in: 0.6, out: 0.6 },
  "llama-3.1-405b": { in: 3.5, out: 3.5 },
  "qwen2.5-72b": { in: 0.8, out: 0.8 },
  "grok-2": { in: 2, out: 10 },
  "grok-3": { in: 3, out: 15 },
};
const FALLBACK = { in: 1.5, out: 5.0 };

export function modelPricing(model = "") {
  const m = String(model).toLowerCase();
  for (const [key, price] of Object.entries(PRICING)) {
    if (m.includes(key)) return price;
  }
  return FALLBACK;
}

// USD estimate of tokens saved by this saver event (input-side savings).
// Only savers with concrete counts are counted (rtk bytes, headroom tokens,
// pxpipe estimate); caveman/ponytail are prompt-style and show as applies.
export function estimateCostSaved(event) {
  if (!event || typeof event !== "object") return 0;
  const { in: inPerM } = modelPricing(event.model);
  let tokens = 0;
  if (event.rtk?.hits?.length) {
    tokens += Math.max(0, (event.rtk.bytesBefore || 0) - (event.rtk.bytesAfter || 0)) / 4;
  }
  if (event.headroom?.tokens_saved > 0) tokens += event.headroom.tokens_saved;
  if (event.pxpipe?.applied) tokens += event.pxpipe.tokensSavedEst || 0;
  return (tokens / 1e6) * inPerM;
}

export function formatUSD(value) {
  const v = Number(value) || 0;
  if (v >= 100) return `$${v.toFixed(0)}`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
}