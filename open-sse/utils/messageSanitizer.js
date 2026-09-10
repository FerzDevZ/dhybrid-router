/**
 * 🛡️ 9Router Upstream Message Sanitizer
 * Guarantees structural validity of `messages` arrays across all upstream LLM providers (Zhipu GLM, OpenCode, Qwen, Moonshot, OpenAI, Claude).
 * Fixes upstream error [1214] ("The messages parameter is illegal") by repairing:
 * 1. Orphaned `tool` messages whose parent assistant tool_call was truncated/pruned.
 * 2. Unmatched `tool_calls` in assistant messages with missing `tool` replies.
 * 3. Empty string `content: ""` on assistant messages without tool calls.
 * 4. Incorrect message sequencing and consecutive same-role messages.
 */

export function sanitizeMessagesForUpstream(body) {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return body;
  }

  const rawMessages = body.messages;
  const sanitized = [];

  // Pass 1: Normalize content & structure
  for (let i = 0; i < rawMessages.length; i++) {
    const msg = rawMessages[i];
    if (!msg || typeof msg !== "object") continue;

    const clone = { ...msg };

    // Assistant with tool_calls: content should be null or string, not empty string
    if (clone.role === "assistant" && Array.isArray(clone.tool_calls) && clone.tool_calls.length > 0) {
      if (clone.content === "" || clone.content === undefined) {
        clone.content = null;
      }
      sanitized.push(clone);
      continue;
    }

    // Strip historical reasoning_content on older turns to eliminate monologue loops
    if (clone.role === "assistant" && i < rawMessages.length - 2) {
      if (typeof clone.reasoning_content === "string" && clone.reasoning_content.length > 20) {
        delete clone.reasoning_content;
      }
    }

    // Assistant without tool_calls but empty content: skip unless it is the very last message
    if (clone.role === "assistant" && (!clone.content || (typeof clone.content === "string" && clone.content.trim() === ""))) {
      if (i === rawMessages.length - 1 && clone.reasoning_content && clone.reasoning_content.trim().length > 0) {
        clone.content = clone.reasoning_content;
        sanitized.push(clone);
      }
      // Skip empty intermediate assistant messages without tool calls
      continue;
    }

    // User message with empty content: normalize to single space
    if (clone.role === "user") {
      if (typeof clone.content === "string" && clone.content.trim() === "") {
        clone.content = " ";
      }
    }

    // Tool message with empty content: normalize
    if (clone.role === "tool" || clone.role === "function") {
      if (typeof clone.content === "string" && clone.content.trim() === "") {
        clone.content = "(empty output)";
      }
    }

    sanitized.push(clone);
  }

  // Pass 2: Fix Tool Call & Tool Result Pairing Airtight
  const validMessages = [];
  let i = 0;

  while (i < sanitized.length) {
    const msg = sanitized[i];

    if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const assistantMsg = { ...msg, tool_calls: [...msg.tool_calls] };
      const expectedIds = new Map(assistantMsg.tool_calls.map(tc => [tc.id, tc]));

      // Gather all subsequent tool replies
      let j = i + 1;
      const matchingToolReplies = [];
      const orphanToolReplies = [];

      while (j < sanitized.length && (sanitized[j].role === "tool" || sanitized[j].role === "function")) {
        const tMsg = sanitized[j];
        const tId = tMsg.tool_call_id || tMsg.name;
        if (tId && expectedIds.has(tId)) {
          matchingToolReplies.push(tMsg);
          expectedIds.delete(tId);
        } else {
          orphanToolReplies.push(tMsg);
        }
        j++;
      }

      // If some expected tool calls were NOT answered (e.g. truncated), supply placeholder tool replies
      for (const [missingId, tc] of expectedIds.entries()) {
        matchingToolReplies.push({
          role: "tool",
          tool_call_id: missingId,
          name: tc.function?.name || "tool",
          content: "(completed)"
        });
      }

      validMessages.push(assistantMsg);
      for (const reply of matchingToolReplies) validMessages.push(reply);
      for (const orphan of orphanToolReplies) {
        const orphanText = typeof orphan.content === "string" ? orphan.content : JSON.stringify(orphan.content);
        validMessages.push({
          role: "user",
          content: `[Tool Result (${orphan.name || "tool"}): ${orphanText}]`
        });
      }

      i = j;
      continue;
    }

    if (msg.role === "tool" || msg.role === "function") {
      // Orphan tool message not following an assistant tool call: convert to user message
      const toolContent = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      validMessages.push({
        role: "user",
        content: `[Tool Result (${msg.name || "tool"}): ${toolContent}]`
      });
      i++;
      continue;
    }

    validMessages.push(msg);
    i++;
  }

  // Pass 3: Ensure there is at least one user message and no consecutive duplicate roles where prohibited
  const finalMessages = [];
  for (let i = 0; i < validMessages.length; i++) {
    const msg = validMessages[i];
    const prev = finalMessages[finalMessages.length - 1];

    // Merge consecutive user messages
    if (prev && prev.role === "user" && msg.role === "user") {
      if (typeof prev.content === "string" && typeof msg.content === "string") {
        prev.content = `${prev.content}\n\n${msg.content}`;
        continue;
      }
    }

    finalMessages.push(msg);
  }

  // If after sanitization no user message exists (e.g. only system), add a fallback user message
  const hasUser = finalMessages.some(m => m.role === "user");
  if (!hasUser && finalMessages.length > 0) {
    finalMessages.push({ role: "user", content: "Continue" });
  }

  body.messages = finalMessages;
  return body;
}
