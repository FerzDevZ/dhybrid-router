// Single source of truth for API key masking (CWE-200 / secret disclosure).
// Format: <prefix>***<last6> — same as the legacy rateLimit format.

/**
 * Mask an API key for display/logging. Never returns the full key.
 * @param {string|null|undefined} key
 * @returns {string} masked form, or "" when the key is empty
 */
export function maskKey(key) {
  if (!key || typeof key !== "string") return "";
  if (key.length <= 10) return "***";
  const prefix = key.length > 14 ? key.slice(0, 6) : key.slice(0, 3);
  return `${prefix}***${key.slice(-6)}`;
}

export default maskKey;