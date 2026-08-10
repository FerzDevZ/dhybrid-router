// Output token caps: adaptive max_tokens estimation.
// Never touches reasoning_effort / thinking budgets — input & verbosity only.
import { msgText } from "./trimming.js";

const CODE_PATTERN = /\bfunction\b|=>|\bconst\b|\blet\b|\bclass\b|```|\bdef\s+\w+|import\s+\w+/;

// Estimate how many output tokens the request likely needs.
export function estimateOutputTokens(body) {
  try {
    const items = Array.isArray(body?.messages) ? body.messages
      : Array.isArray(body?.input) ? body.input
      : null;
    if (!items || items.length === 0) return 1024;

    // Only look at the very last user prompt (current intent).
    let lastUser = null;
    for (let i = items.length - 1; i >= 0; i--) {
      const m = items[i];
      if (m && m.role === "user") { lastUser = m; break; }
    }
    const text = msgText(lastUser || {});
    if (text.length > 1200 || CODE_PATTERN.test(text)) return 4096;
    return 1024;
  } catch {
    return 1024;
  }
}

/**
 * Cap max output tokens to the estimate unless the caller explicitly set a
 * smaller value (their intent wins). Supports openai chat / claude (max_tokens),
 * responses (max_output_tokens), ollama (num_predict).
 * Returns { savedTokens, maxTokens } (savedTokens = dropped excess) or null.
 */
export function capOutputTokens(body, enabled) {
  if (!enabled) return null;
  if (!body || typeof body !== "object") return null;
  // Unknown shape (no message array) → fail open, never touch the body
  if (!Array.isArray(body.messages) && !Array.isArray(body.input)) return null;

  const estimate = estimateOutputTokens(body);
  const cap = estimate * 2;
  const field = body.max_output_tokens !== undefined ? "max_output_tokens"
    : body.max_tokens !== undefined ? "max_tokens"
    : body.num_predict !== undefined ? "num_predict"
    : null;

  if (!field) {
    // No cap set: add the fitting field for the shape (chat vs responses).
    const target = Array.isArray(body.input) ? "max_output_tokens" : "max_tokens";
    body[target] = estimate;
    return { savedTokens: 0, maxTokens: estimate };
  }

  if (body[field] > cap) {
    const savedTokens = body[field] - estimate;
    body[field] = estimate;
    return { savedTokens, maxTokens: estimate };
  }
  return null;
}
