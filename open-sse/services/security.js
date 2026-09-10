/**
 * 🔒 9Router Security, Secret Sanitizer & Quota Enforcer
 * Masks credentials (Bearer tokens, sk-..., private keys) in log outputs.
 */

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9\-_]{20,}/g,
  /Bearer\s+[a-zA-Z0-9\-_.]+/gi,
  /xoxb-[a-zA-Z0-9\-]+/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  /glpat-[a-zA-Z0-9\-_]+/g,
];

export function sanitizeLogOutput(text) {
  if (typeof text !== "string") return text;
  let sanitized = text;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) => {
      if (match.startsWith("Bearer ")) {
        return "Bearer [REDACTED_TOKEN]";
      }
      return `${match.slice(0, 4)}...[REDACTED]`;
    });
  }
  return sanitized;
}

export function validateApiKeyQuota(apiKeyMeta, estimatedTokens = 1000) {
  if (!apiKeyMeta) return { valid: true };
  if (apiKeyMeta.maxTokensPerDay && apiKeyMeta.tokensUsedToday + estimatedTokens > apiKeyMeta.maxTokensPerDay) {
    return { valid: false, error: "Daily token quota exceeded" };
  }
  return { valid: true };
}
