// Smart JSON / YAML Minifier: compacts verbose tool result payloads (APIs, schemas, configs)
// by stripping unnecessary whitespace and indentations while preserving 100% structural validity.

/**
 * Checks if a string appears to be a large formatted JSON payload.
 */
export function isFormattedJson(text) {
  if (typeof text !== "string" || text.length < 200) return false;
  const trimmed = text.trim();
  return (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  );
}

/**
 * Minifies JSON string safely. Returns minified string or original text on parse failure.
 */
export function minifyJsonText(text) {
  if (!isFormattedJson(text)) return text;
  try {
    const parsed = JSON.parse(text);
    return JSON.stringify(parsed);
  } catch {
    // If not strict JSON, return original text unchanged (fail-open)
    return text;
  }
}
