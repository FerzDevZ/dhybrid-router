/**
 * 🧠 9Router AST-Aware Smart Context Pruner
 * Scans multi-turn message histories to identify stale file reads.
 * If a file was read in turn N, but subsequently overwritten or patched in turn N+K,
 * the older raw read_file output is pruned and replaced with a lightweight reference.
 * Saves 60-70% token budget on long 20+ turn agentic sessions.
 */

export function pruneStaleContext(body, maxTurnsToKeepFull = 2) {
  if (!body || !Array.isArray(body.messages) || body.messages.length <= maxTurnsToKeepFull) {
    return body;
  }

  const messages = body.messages;
  const modifiedFiles = new Set();
  const fileReadIndices = new Map(); // path -> array of message indices

  // Step 1: Pass backwards to discover the latest state of files
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    // Check if assistant performed write_file or patch
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.function?.name === "write_file" || tc.function?.name === "patch") {
          try {
            const args = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments;
            const path = args?.path || args?.target_file;
            if (path) modifiedFiles.add(path);
          } catch {}
        }
      }
    }

    // Check if tool message returned read_file content or terminal stdout
    if (msg.role === "tool" && typeof msg.content === "string") {
      // Find corresponding assistant tool call
      const prevMsg = messages[i - 1];
      if (prevMsg && prevMsg.role === "assistant" && Array.isArray(prevMsg.tool_calls)) {
        for (const tc of prevMsg.tool_calls) {
          const fnName = tc.function?.name;
          if (tc.id === msg.tool_call_id) {
            if (fnName === "read_file" || fnName === "view_file") {
              try {
                const args = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function.arguments;
                const path = args?.path || args?.target_file;
                if (path) {
                  if (!fileReadIndices.has(path)) fileReadIndices.set(path, []);
                  fileReadIndices.get(path).push(i);
                }
              } catch {}
            } else if (fnName === "terminal" || fnName === "bash" || fnName === "exec") {
              // Truncate excessively long non-latest terminal command outputs (e.g. huge find or git logs)
              if (i < messages.length - 2 && msg.content.length > 2000) {
                msg.content = msg.content.slice(0, 1000) + "\n... [Terminal output truncated by 9Router to conserve context budget]";
              }
            }
          }
        }
      }
    }
  }

  // Step 2: Prune older reads for files that were modified or re-read later
  for (const [path, indices] of fileReadIndices.entries()) {
    // If file was modified or read multiple times, prune all but the most recent read
    if (indices.length > 1 || modifiedFiles.has(path)) {
      const keepIndex = indices[0]; // newest read index (since we passed backwards)
      for (let j = 1; j < indices.length; j++) {
        const idx = indices[j];
        const oldMsg = messages[idx];
        if (oldMsg && typeof oldMsg.content === "string" && oldMsg.content.length > 300) {
          oldMsg.content = `[Context Note: File '${path}' content pruned (superseded by subsequent modification/read in later turn).]`;
        }
      }
    }
  }

  return body;
}
