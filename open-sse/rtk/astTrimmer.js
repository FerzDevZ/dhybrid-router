/**
 * AST-Aware Code Trimming Module for RTK (Request Token Killer)
 * Intelligently compresses large code blocks by preserving signatures & declarations
 * while trimming verbose function bodies.
 */

/**
 * Trim code block string using pattern matching for signatures
 * @param {string} code
 * @param {string} lang
 * @returns {string}
 */
export function trimCodeBlockSignatures(code, lang = "") {
  if (!code || code.length < 600) return code;

  const lines = code.split("\n");
  const trimmedLines = [];
  let inFunctionBody = false;
  let braceDepth = 0;
  let bodyLinesSkipped = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Check for declarations/signatures (exports, functions, classes, interfaces, types, imports)
    const isSignature = /^(export\s+)?(async\s+)?(function|class|interface|type|const|let|var|import|package|public|private|protected|def|fn|struct|enum)\b/.test(trimmed)
      || trimmed.endsWith("{")
      || trimmed.endsWith(";")
      || i < 5; // Preserve top header

    if (isSignature) {
      if (bodyLinesSkipped > 0) {
        trimmedLines.push(`    // ... [RTK AST: ${bodyLinesSkipped} lines of implementation body trimmed] ...`);
        bodyLinesSkipped = 0;
      }
      trimmedLines.push(line);
    } else {
      if (line.includes("{")) braceDepth++;
      if (line.includes("}")) braceDepth--;

      if (braceDepth > 0) {
        bodyLinesSkipped++;
      } else {
        if (bodyLinesSkipped > 0) {
          trimmedLines.push(`    // ... [RTK AST: ${bodyLinesSkipped} lines of implementation body trimmed] ...`);
          bodyLinesSkipped = 0;
        }
        trimmedLines.push(line);
      }
    }
  }

  if (bodyLinesSkipped > 0) {
    trimmedLines.push(`    // ... [RTK AST: ${bodyLinesSkipped} lines of implementation body trimmed] ...`);
  }

  return trimmedLines.join("\n");
}

/**
 * Trim AST signatures across code blocks in request body messages
 * @param {object} body
 * @param {number} thresholdChars
 * @returns {{ trimmedBlocks: number, savedChars: number } | null}
 */
export function trimAstCodeBlocks(body, thresholdChars = 8000) {
  if (!body || !Array.isArray(body.messages)) return null;

  let totalChars = 0;
  for (const m of body.messages) {
    if (typeof m?.content === "string") totalChars += m.content.length;
  }

  if (totalChars < thresholdChars) return null;

  let trimmedBlocks = 0;
  let savedChars = 0;

  for (const m of body.messages) {
    if (typeof m?.content !== "string") continue;
    const initialLen = m.content.length;

    m.content = m.content.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
      if (code.length > 800) {
        const trimmedCode = trimCodeBlockSignatures(code, lang);
        if (trimmedCode.length < code.length) {
          trimmedBlocks++;
          return `\`\`\`${lang}\n${trimmedCode}\n\`\`\``;
        }
      }
      return match;
    });

    savedChars += (initialLen - m.content.length);
  }

  if (trimmedBlocks > 0) {
    return { trimmedBlocks, savedChars };
  }
  return null;
}
