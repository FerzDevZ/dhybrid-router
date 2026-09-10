/**
 * 📈 9Router Dynamic Max Output Tokens Maximizer
 * Safely defaults max_tokens to 4096 when omitted by client, preventing arbitrary truncations
 * while strictly avoiding upstream quota float overflow in billing middleware.
 */

export function maximizeOutputTokens(body, modelOrCombo = "") {
  if (!body || typeof body !== "object") return body;

  // If max_tokens is already set by client, preserve it exactly as requested
  if (body.max_tokens !== undefined || body.max_completion_tokens !== undefined || body.max_output_tokens !== undefined) {
    return body;
  }

  const modelStr = String(modelOrCombo || body.model || "").toLowerCase();
  const maxOutput = modelStr.includes("grok") || modelStr.includes("claude") ? 131072 : 65536;

  // If omitted, default to high-capacity 65K-131K tokens
  return {
    ...body,
    max_tokens: maxOutput,
  };
}
