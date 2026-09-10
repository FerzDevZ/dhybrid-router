/**
 * Post-Read Enforcer — Injects mandatory write directives when the model
 * just read files but hasn't written anything yet.
 *
 * This is the most powerful anti-hallucination mechanism because it works
 * at the REQUEST level (before the model generates), injecting enforcement
 * text into the last tool_result or as a final user message. Models pay
 * much stronger attention to messages at the END of context than system
 * prompts at the beginning.
 *
 * Detection: If the conversation contains read_file/search_files/grep
 * tool results but NO write_file/patch tool calls, the model is in a
 * "post-read" state and must be forced to call write tools.
 */

// ── Tool classification ─────────────────────────────────────────────────────

const READ_TOOLS = new Set([
  "read_file", "search_files", "grep", "list_files", "find_files",
  "search_code", "view_file", "cat", "find", "list_dir",
  "preparing search_files", "preparing read_file",
  "execute_code", "bash", "terminal", "exec", "shell", "run_command",
  "session_search", "search_workspace",
]);

const WRITE_TOOLS = new Set([
  "write_file", "patch", "write_to_file", "create_file",
  "edit_file", "replace_in_file", "insert_code_block",
  "apply_diff", "str_replace_editor", "file_editor",
  "replace_file_content", "multi_replace_file_content",
]);

// ── Action keywords that indicate user wants changes or disk modifications ───

const WRITE_ACTION_KEYWORDS = [
  "perbaiki", "fix", "implementasi", "implement", "terapkan", "apply",
  "buatkan file", "tulis file", "create file", "ubah file", "update file",
  "refactor", "patch", "hapus", "delete", "write",
];

const PLANNING_STUDY_KEYWORDS = [
  "planning", "rencana", "pelajari", "analisis", "review", "saran",
  "jelaskan", "bagaimana", "diskusikan", "konsep", "ide",
];

// ── Enforcement messages ────────────────────────────────────────────────────

const ENFORCER_ID = `[MANDATORY EXECUTION DIRECTIVE]
Kamu diminta menerapkan perubahan/perbaikan kode.
Jika tugasnya memodifikasi file: gunakan tool write_file/patch.
Jika tugasnya hanya analisis/planning: sampaikan secara terstruktur dan padat.`;

const ENFORCER_EN = `[MANDATORY EXECUTION DIRECTIVE]
When requested to implement code changes, use write_file/patch tools directly.
If requested to plan or analyze, provide concise structured analysis.`;

/**
 * Analyze conversation body to detect post-read state.
 * Returns { isPostRead, hasWriteTools, hasReadTools, hasActionIntent }
 */
export function analyzeConversationState(body) {
  if (!body) return { isPostRead: false, hasWriteTools: false, hasReadTools: false, hasActionIntent: false };

  let hasReadTools = false;
  let hasWriteTools = false;
  let hasWriteActionIntent = false;
  let isPlanningOrStudy = false;
  let lastAssistantHadReadTool = false;

  // Check for action intent in user messages
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const input = Array.isArray(body.input) ? body.input : [];

  // OpenAI Messages format
  for (const msg of messages) {
    if (!msg) continue;

    // Check user messages for intent
    if (msg.role === "user" && typeof msg.content === "string") {
      const lower = msg.content.toLowerCase();
      if (PLANNING_STUDY_KEYWORDS.some(k => lower.includes(k))) {
        isPlanningOrStudy = true;
      }
      if (WRITE_ACTION_KEYWORDS.some(k => lower.includes(k))) {
        hasWriteActionIntent = true;
      }
    }

    // Check assistant tool_calls
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      lastAssistantHadReadTool = false;
      for (const tc of msg.tool_calls) {
        const name = (tc?.function?.name || tc?.name || "").toLowerCase();
        if (WRITE_TOOLS.has(name)) {
          hasWriteTools = true;
        }
        if (READ_TOOLS.has(name)) {
          hasReadTools = true;
          lastAssistantHadReadTool = true;
        }
      }
    }

    // Reset lastAssistantHadReadTool on new assistant message without reads
    if (msg.role === "assistant" && !Array.isArray(msg.tool_calls)) {
      lastAssistantHadReadTool = false;
    }
  }

  // OpenAI Responses format
  for (const item of input) {
    if (!item) continue;
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const name = (item.name || "").toLowerCase();
      if (WRITE_TOOLS.has(name)) hasWriteTools = true;
      if (READ_TOOLS.has(name)) {
        hasReadTools = true;
        lastAssistantHadReadTool = true;
      }
    }
  }

  // Post-read write enforcement ONLY when user explicitly wants modifications and NOT planning
  const isPostRead = hasReadTools && !hasWriteTools && hasWriteActionIntent && !isPlanningOrStudy;

  return { isPostRead, hasWriteTools, hasReadTools, hasActionIntent: hasWriteActionIntent, lastAssistantHadReadTool };
}

/**
 * Check if the LAST message in the conversation is a tool result (from read),
 * meaning the model is about to generate its response after reading.
 */
function isLastMessageToolResult(body) {
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    const last = body.messages[body.messages.length - 1];
    return last && (last.role === "tool" || last.role === "function");
  }
  if (Array.isArray(body.input) && body.input.length > 0) {
    const last = body.input[body.input.length - 1];
    return last && (last.type === "function_call_output" || last.role === "tool");
  }
  return false;
}

/**
 * Detect language from conversation and return appropriate enforcer.
 */
function getEnforcerText(body) {
  let text = "";
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const msg of messages) {
    if (msg?.role === "user" && typeof msg.content === "string") {
      text += msg.content + " ";
    }
  }
  const idMarkers = (text.match(/\b(saya|kamu|untuk|dengan|dari|yang|ini|itu|bisa|tidak|sudah|ada|mau|tolong|coba)\b/gi) || []).length;
  return idMarkers > 2 ? ENFORCER_ID : ENFORCER_EN;
}

/**
 * Inject post-read enforcer into the request body.
 * Adds enforcement text to the last tool result message or as a new developer message.
 * This is the MOST effective position because models attend strongly to recent context.
 *
 * @param {object} body - Request body (mutated in-place)
 * @returns {{ injected: boolean, reason: string }}
 */
export function injectPostReadEnforcer(body) {
  // Disabled to prevent unwanted forced write directives
  return { injected: false, reason: "disabled" };
}
