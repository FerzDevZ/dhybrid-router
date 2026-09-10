/**
 * Output Guard — Detects false completion claims in model output.
 *
 * When a model claims "sudah saya terapkan" or "I have implemented" but the
 * conversation history shows NO write_file/patch tool calls were made, this
 * module detects the false claim and can inject a disclaimer.
 *
 * This is a HARD enforcement layer — unlike system prompt injection (soft),
 * this intercepts actual output and modifies it when hallucination is detected.
 */

// ── False-claim detection patterns ──────────────────────────────────────────

const FALSE_CLAIM_PATTERNS_ID = [
  /sudah\s+(saya\s+)?(terapkan|implementasikan|buatkan|ubah|optimasi|dioptimasi|pasang|buat|kerjakan|modifikasi|perbaiki|fix|selesaikan|update|patch)/i,
  /telah\s+(saya\s+)?(terapkan|ubah|modifikasi|implementasikan|buatkan|optimasi|perbaiki|fix|selesaikan)/i,
  /berhasil\s+di(terapkan|optimasi|ubah|implementasikan|perbaiki|fix)/i,
  /sudah\s+di(optimasi|terapkan|ubah|modifikasi|perbaiki|fix|update|patch)/i,
  /sudah\s+(saya\s+)?fix\b/i,
  /sudah\s+diperbaiki\s+(sepenuhnya|semua|seluruh|lengkap|100)/i,
  /yang\s+sudah\s+saya\s+terapkan\s+ke\s+seluruh/i,
  /\(sudah\s+dioptimasi\)/i,
  /perubahan.*sudah.*diterapkan/i,
  /file\s+yang\s+sudah\s+di(perbaiki|ubah|update|modifikasi|fix)/i,
  /sudah\s+saya\s+fix\s+\d+%/i,
  /error.*sudah\s+(saya\s+)?fix/i,
];

const FALSE_CLAIM_PATTERNS_EN = [
  /I\s+have\s+(already\s+)?(implemented|applied|updated|modified|optimized|fixed|patched|changed|written|resolved|corrected)/i,
  /I'?ve\s+(already\s+)?(implemented|applied|updated|modified|optimized|fixed|patched|changed|written|resolved|corrected)/i,
  /successfully\s+(applied|implemented|updated|modified|optimized|fixed|written|resolved|corrected|patched)/i,
  /changes?\s+(?:have|has)\s+been\s+(applied|implemented|made|written|fixed)/i,
  /already\s+(?:applied|implemented|updated|modified|optimized|fixed|patched|resolved)/i,
  /(?:bug|error|issue)\s+(?:has been|is)\s+(?:fixed|resolved|corrected)/i,
];

const ALL_CLAIM_PATTERNS = [...FALSE_CLAIM_PATTERNS_ID, ...FALSE_CLAIM_PATTERNS_EN];

// ── Write-tool detection in conversation history ────────────────────────────

const WRITE_TOOL_NAMES = new Set([
  "write_file", "patch", "write_to_file", "create_file",
  "edit_file", "replace_in_file", "insert_code_block",
  "apply_diff", "str_replace_editor", "file_editor",
  "replace_file_content", "multi_replace_file_content",
]);

/**
 * Check if the request body's conversation history contains any write-tool
 * calls (tool_calls in assistant messages or function_call_output in input).
 */
function hasWriteToolInHistory(body) {
  if (!body) return false;

  // OpenAI messages format
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg?.role === "assistant" && Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          const name = tc?.function?.name || tc?.name || "";
          if (WRITE_TOOL_NAMES.has(name)) return true;
        }
      }
    }
  }

  // OpenAI Responses format
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item?.type === "function_call" || item?.type === "custom_tool_call") {
        const name = item?.name || "";
        if (WRITE_TOOL_NAMES.has(name)) return true;
      }
    }
  }

  return false;
}

// ── Core detection ──────────────────────────────────────────────────────────

/**
 * Detect if output text contains false completion claims.
 * Returns { detected: boolean, patterns: string[] }
 */
export function detectFalseCompletionClaim(outputText, requestBody) {
  if (!outputText || typeof outputText !== "string") {
    return { detected: false, patterns: [] };
  }

  // If the conversation actually contains write tools, claims are legitimate
  if (hasWriteToolInHistory(requestBody)) {
    return { detected: false, patterns: [] };
  }

  const matchedPatterns = [];
  for (const pattern of ALL_CLAIM_PATTERNS) {
    if (pattern.test(outputText)) {
      matchedPatterns.push(pattern.source);
    }
  }

  return {
    detected: matchedPatterns.length > 0,
    patterns: matchedPatterns,
  };
}

// ── Disclaimer injection ────────────────────────────────────────────────────

const DISCLAIMER_ID = "\n\n⚠️ **PERINGATAN**: Rekomendasi di atas adalah SARAN yang belum diterapkan ke file. File belum dimodifikasi. Gunakan perintah eksplisit (misal: \"terapkan semua saran\") untuk menerapkannya.";
const DISCLAIMER_EN = "\n\n⚠️ **WARNING**: The suggestions above have NOT been applied to any files. No files were modified. Use an explicit command to apply them.";

/**
 * Detect language bias of the text and return appropriate disclaimer.
 */
function getDisclaimer(text) {
  // Count Indonesian vs English markers
  const idMarkers = (text.match(/\b(sudah|saya|yang|untuk|dengan|dari|ke|di|belum|ada|ini|itu|perlu|bisa|tidak|sudah|juga|atau)\b/gi) || []).length;
  const enMarkers = (text.match(/\b(the|is|are|was|were|have|has|been|will|would|can|should|this|that|with|from)\b/gi) || []).length;
  return idMarkers >= enMarkers ? DISCLAIMER_ID : DISCLAIMER_EN;
}

/**
 * If false claims are detected, append a disclaimer to the text.
 * Returns { text: string, modified: boolean }
 */
export function guardOutput(outputText, requestBody) {
  const detection = detectFalseCompletionClaim(outputText, requestBody);
  if (!detection.detected) {
    return { text: outputText, modified: false };
  }
  const disclaimer = getDisclaimer(outputText);
  return {
    text: outputText + disclaimer,
    modified: true,
    matchedPatterns: detection.patterns,
  };
}

/**
 * Apply output guard to an OpenAI Chat Completions response body (non-streaming).
 * Mutates the response in-place for efficiency.
 * Returns { modified: boolean, patterns: string[] }
 */
export function guardNonStreamingResponse(responseBody, requestBody) {
  if (!responseBody?.choices?.[0]?.message?.content) {
    return { modified: false, patterns: [] };
  }

  const content = responseBody.choices[0].message.content;
  const result = guardOutput(content, requestBody);
  if (result.modified) {
    responseBody.choices[0].message.content = result.text;
    return { modified: true, patterns: result.matchedPatterns || [] };
  }
  return { modified: false, patterns: [] };
}

/**
 * Apply output guard to Responses API response body (non-streaming).
 */
export function guardResponsesApiResponse(responseBody, requestBody) {
  if (!responseBody?.output || !Array.isArray(responseBody.output)) {
    return { modified: false, patterns: [] };
  }

  let anyModified = false;
  const allPatterns = [];

  for (const item of responseBody.output) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const block of item.content) {
        if (block?.type === "output_text" && typeof block.text === "string") {
          const result = guardOutput(block.text, requestBody);
          if (result.modified) {
            block.text = result.text;
            anyModified = true;
            allPatterns.push(...(result.matchedPatterns || []));
          }
        }
      }
    }
  }

  return { modified: anyModified, patterns: allPatterns };
}
