/**
 * 🪄 9Router Auto-Tool Extractor (Zero-Chat Code Capturer)
 * Intercepts model responses containing raw markdown code blocks with file paths
 * and synthesizes structured `write_file` tool calls if the model omitted them.
 */

const FILE_HEADER_REGEX = /^(?:(?:\/\/|#|\/\*|<!--|===?)\s*(?:file(?:name)?|path)?[:\s=]*([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)\s*(?:\*\/|-->|===?)?)/im;
const CODEBLOCK_WITH_PATH_REGEX = /```(?:[a-zA-Z0-9_\-]+)?\s*(?:(?:file|path)?[:\s=]+)?([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)\n([\s\S]*?)```/g;
const GENERIC_CODEBLOCK_REGEX = /```(?:[a-zA-Z0-9_\-]+)?\n([\s\S]*?)```/g;
const SECTION_FILE_REGEX = /(?:===+|###?)\s*([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)\s*===*\n+([\s\S]*?)(?=(?:===+|###?)\s*[a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+\s*===*|$)/g;

/**
 * Extract file modifications from raw assistant text content.
 * Returns array of { path, content } or null if none found.
 */
export function extractCodeFilesFromText(text) {
  if (!text || typeof text !== "string") {
    return null;
  }

  const files = [];

  // Pattern 1: Codeblock with file path in language tag: ```tsx src/app/page.tsx
  let match;
  CODEBLOCK_WITH_PATH_REGEX.lastIndex = 0;
  while ((match = CODEBLOCK_WITH_PATH_REGEX.exec(text)) !== null) {
    const rawPath = match[1]?.trim();
    const codeContent = match[2];
    if (rawPath && codeContent && !rawPath.includes(" ") && rawPath.includes(".")) {
      files.push({ path: rawPath, content: codeContent });
    }
  }

  // Pattern 2: Generic codeblock with file comment on line 1: // file: src/app/page.tsx or === file.tsx ===
  if (files.length === 0 && text.includes("```")) {
    GENERIC_CODEBLOCK_REGEX.lastIndex = 0;
    while ((match = GENERIC_CODEBLOCK_REGEX.exec(text)) !== null) {
      const codeBlock = match[1];
      const headerMatch = FILE_HEADER_REGEX.exec(codeBlock);
      if (headerMatch && headerMatch[1]) {
        const rawPath = headerMatch[1].trim();
        if (rawPath && !rawPath.includes(" ") && rawPath.includes(".")) {
          // Strip header line from content
          const cleanContent = codeBlock.replace(FILE_HEADER_REGEX, "").trimStart();
          files.push({ path: rawPath, content: cleanContent });
        }
      }
    }
  }

  // Pattern 3: Unfenced section file dumps: === layout.tsx ===\n...code...
  if (files.length === 0) {
    SECTION_FILE_REGEX.lastIndex = 0;
    while ((match = SECTION_FILE_REGEX.exec(text)) !== null) {
      const rawPath = match[1]?.trim();
      const codeContent = match[2]?.trim();
      if (rawPath && codeContent && !rawPath.includes(" ") && rawPath.includes(".") && codeContent.length > 20) {
        files.push({ path: rawPath, content: codeContent });
      }
    }
  }

  return files.length > 0 ? files : null;
}

/**
 * Auto-synthesizes tool_calls on non-streaming OpenAI Chat Completion response.
 * If the model outputted raw code instead of calling write_file, converts it to write_file tool_calls.
 */
export function autoSynthesizeToolCalls(responseBody) {
  if (!responseBody?.choices?.[0]?.message) return responseBody;

  const msg = responseBody.choices[0].message;

  // Only synthesize if model did NOT provide its own tool_calls
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    return responseBody;
  }

  const content = msg.content;
  if (!content || typeof content !== "string") return responseBody;

  const files = extractCodeFilesFromText(content);
  if (!files || files.length === 0) return responseBody;

  // Synthesize write_file tool calls
  const toolCalls = files.map((f, idx) => ({
    id: `call_auto_${Date.now()}_${idx}`,
    type: "function",
    function: {
      name: "write_file",
      arguments: JSON.stringify({
        path: f.path,
        content: f.content,
      }),
    },
  }));

  msg.tool_calls = toolCalls;
  msg.content = `Auto-converted code block into write_file tool execution for: ${files.map(f => f.path).join(", ")}`;

  return responseBody;
}
