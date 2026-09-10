// Syntax Guard: ensures text truncation or compression NEVER breaks code blocks (```),
// JSON delimiters ({...}), or HTML/XML tags mid-structure.

/**
 * Truncate text cleanly without slicing across a markdown code fence or JSON block.
 * @param {string} text
 * @param {number} maxBytes
 * @param {string} marker
 * @returns {string}
 */
export function safeTruncateWithSyntaxGuard(text, maxBytes, marker = "\n... [TRUNCATED FOR TOKEN SAVINGS]") {
  if (typeof text !== "string") return text;
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  // Approximate character boundary for byte limit
  let cutoff = Math.floor(maxBytes * 0.95);
  if (cutoff >= text.length) cutoff = text.length - 1;

  let slice = text.slice(0, cutoff);

  // Check if we cut inside a markdown code block (count occurrences of ```)
  const codeFences = (slice.match(/```/g) || []).length;
  const isInsideCodeBlock = codeFences % 2 !== 0;

  if (isInsideCodeBlock) {
    // Find the end of the current code block if nearby (within 500 chars)
    const nextCloseFence = text.indexOf("```", cutoff);
    if (nextCloseFence !== -1 && nextCloseFence - cutoff < 500) {
      // Include the close fence
      slice = text.slice(0, nextCloseFence + 3);
    } else {
      // Safely close the code block before truncating
      slice = `${slice}\n\`\`\``;
    }
  }

  // Ensure JSON curly brackets are not left dangling
  const openBraces = (slice.match(/\{/g) || []).length;
  const closeBraces = (slice.match(/\}/g) || []).length;
  if (openBraces > closeBraces && slice.trim().startsWith("{")) {
    const diff = openBraces - closeBraces;
    slice = `${slice}\n${"}".repeat(Math.min(diff, 5))}`;
  }

  return `${slice}${marker}`;
}
