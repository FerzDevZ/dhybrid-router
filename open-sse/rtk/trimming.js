// Token-saver trimming helpers: message dedup, history trim, lightweight summary.
// Pure + sync, format-agnostic (OpenAI/Claude `messages` + OpenAI Responses `input`).
// Every function fails open: unknown shape or error → return null, body untouched.
const encoder = new TextEncoder();

function bytesOf(str) {
  try {
    return encoder.encode(str).length;
  } catch {
    return 0;
  }
}

function itemsOf(body) {
  if (!body) return null;
  const items = Array.isArray(body.messages) ? body.messages
    : Array.isArray(body.input) ? body.input
    : null;
  return items && items.length > 0 ? items : null;
}

function totalBytes(items) {
  let total = 0;
  for (const msg of items) {
    if (!msg) continue;
    const s = JSON.stringify(msg);
    if (s) total += bytesOf(s);
  }
  return total;
}

export function msgText(msg) {
  // Best-effort plain-text extraction for summary bullets.
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p) => p && (p.type === "text" || p.type === "input_text") && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
  }
  if (msg.type === "function_call_output") {
    if (typeof msg.output === "string") return msg.output;
    if (Array.isArray(msg.output)) {
      return msg.output
        .filter((p) => p && p.type === "input_text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n");
    }
  }
  return "";
}

/**
 * Drop consecutive messages that are JSON-identical (repeated tool_result,
 * repeated prompts). Returns { savedBytes, removed } or null when no-op/unknown.
 */
export function dedupMessages(body) {
  try {
    const items = itemsOf(body);
    if (!items || items.length < 2) return null;

    const out = [];
    let removed = 0;
    let savedBytes = 0;
    let lastKey = null;
    for (const msg of items) {
      if (!msg) { out.push(msg); continue; }
      const key = JSON.stringify(msg);
      if (key === lastKey) {
        savedBytes += bytesOf(key);
        removed++;
        continue;
      }
      lastKey = key;
      out.push(msg);
    }
    if (!removed) return null;
    replaceItems(body, out);
    return { savedBytes, removed };
  } catch {
    return null;
  }
}

/**
 * Drop oldest messages until total bytes ≤ maxBytes (sliding window).
 * Always keeps system message (if any) + last keepMin messages.
 * maxBytes ≤ 0 → off (returns null). Returns { savedBytes, removed } or null.
 */
export function trimHistory(body, maxBytes, keepMin) {
  try {
    if (!maxBytes || maxBytes <= 0) return null;
    const items = itemsOf(body);
    if (!items) return null;
    const keep = Math.max(1, Number.isFinite(keepMin) ? keepMin : 6);

    // system messages are pinned at the front (usually index 0); find them.
    const systemIdx = [];
    items.forEach((msg, i) => { if (msg && msg.role === "system") systemIdx.push(i); });
    const pinned = new Set(systemIdx);

    let total = totalBytes(items);
    if (total <= maxBytes) return null;

    let removedBytes = 0;
    let removed = 0;
    let dropUntil = items.length - keep;
    for (let i = 0; i < items.length && total > maxBytes && i < dropUntil; i++) {
      const msg = items[i];
      if (!msg) continue;
      if (pinned.has(i)) continue; // never drop system
      const s = JSON.stringify(msg);
      const size = s ? bytesOf(s) : 0;
      total -= size;
      removedBytes += size;
      removed++;
      items[i] = null;
    }
    if (!removed) return null;
    const out = items.filter(Boolean);
    replaceItems(body, out);
    return { savedBytes: removedBytes, removed };
  } catch {
    return null;
  }
}

/**
 * Replace middle messages (not system, not last 3) with a single system
 * message of heuristic bullet summary of old user prompts. No LLM call.
 * body bytes must exceed aboveBytes. Returns { savedBytes, removed } or null.
 */
export function injectConversationSummary(body, aboveBytes) {
  try {
    if (!aboveBytes || aboveBytes <= 0) return null;
    const items = itemsOf(body);
    if (!items) return null;
    if (totalBytes(items) <= aboveBytes) return null;
    if (items.length < 6) return null; // nothing meaningful to collapse

    // Collect old user prompts, excluding the very last message.
    const bullets = [];
    const seen = new Set();
    for (let i = 0; i < items.length - 1; i++) {
      const msg = items[i];
      if (!msg || msg.role !== "user") continue;
      const text = msgText(msg).trim();
      if (!text) continue;
      const head = text.slice(0, 100);
      if (seen.has(head)) continue;
      seen.add(head);
      bullets.push(`- ${head}`);
      if (bullets.length >= 20) break;
    }
    if (bullets.length < 2) return null; // too little signal, don't touch

    const summaryText = `Conversation summary (auto, non-authoritative):\n${bullets.join("\n")}`;
    const summaryMsg = { role: "system", content: summaryText };

    const pinnedTail = items.slice(-3);
    let removedBytes = 0;
    let removed = 0;
    const out = [];
    let inserted = false;
    for (let i = 0; i < items.length - 3; i++) {
      const msg = items[i];
      if (!msg) continue;
      if (msg.role === "system") { out.push(msg); continue; }
      if (!inserted) {
        out.push(summaryMsg);
        inserted = true;
      }
      const s = JSON.stringify(msg);
      if (s) removedBytes += bytesOf(s);
      removed++;
    }
    if (!inserted) return null;
    out.push(...pinnedTail);
    if (out.length >= items.length) return null; // must actually shrink
    const savedBytes = removedBytes - bytesOf(JSON.stringify(summaryMsg));
    if (savedBytes <= 0) return null;
    replaceItems(body, out);
    return { savedBytes, removed };
  } catch {
    return null;
  }
}

function replaceItems(body, out) {
  if (Array.isArray(body.messages)) body.messages = out;
  else if (Array.isArray(body.input)) body.input = out;
}

/**
 * Generic head/tail truncation for oversized tool results that RTK's pattern
 * filters don't recognize (JSON dumps, plain files, …). Adds an explicit
 * truncation marker so the model knows context was cut. Error traces preserved.
 * maxBytes ≤ 0 → off (returns null). Returns { savedBytes, truncated } or null.
 */
export function truncateToolResults(body, maxBytes) {
  try {
    if (!maxBytes || maxBytes <= 0) return null;
    const items = itemsOf(body);
    if (!items) return null;

    let savedBytes = 0;
    let truncated = 0;

    const visitText = (text, kind, isError) => {
      if (isError) return text;
      const bytes = bytesOf(text);
      if (bytes <= maxBytes) return text;
      const headLen = Math.floor(text.length * 0.25);
      const tailLen = Math.max(1, Math.floor(text.length * 0.05));
      const marker = `\n[...truncated: ${bytes} bytes...]\n`;
      const out = text.slice(0, headLen) + marker + text.slice(-tailLen);
      savedBytes += bytes - bytesOf(out);
      truncated++;
      return out;
    };

    for (const msg of items) {
      if (!msg) continue;

      // OpenAI Responses: { type:"function_call_output", output: string | [{type:"input_text",text}] }
      if (msg.type === "function_call_output") {
        if (typeof msg.output === "string") {
          msg.output = visitText(msg.output, "responses", false);
        } else if (Array.isArray(msg.output)) {
          for (const part of msg.output) {
            if (part && part.type === "input_text" && typeof part.text === "string") {
              part.text = visitText(part.text, "responses", false);
            }
          }
        }
        continue;
      }

      // OpenAI tool message: string or [{type:"text",text}]
      if (msg.role === "tool") {
        if (typeof msg.content === "string") {
          msg.content = visitText(msg.content, "openai-tool", false);
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part && part.type === "text" && typeof part.text === "string") {
              part.text = visitText(part.text, "openai-tool", false);
            }
          }
        }
        continue;
      }

      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (!block || block.type !== "tool_result") continue;
        const isError = block.is_error === true;
        if (typeof block.content === "string") {
          block.content = visitText(block.content, "claude-string", isError);
        } else if (Array.isArray(block.content)) {
          for (const part of block.content) {
            if (part && part.type === "text" && typeof part.text === "string") {
              part.text = visitText(part.text, "claude-array", isError);
            }
          }
        }
      }
    }

    if (!truncated) return null;
    return { savedBytes, truncated };
  } catch {
    return null;
  }
}

/**
 * Drop image blocks (base64 data / image_url) whose signature already appeared
 * earlier in the conversation (repeated screenshots by coding agents).
 * Only touches image blocks — never text/tool content.
 * Returns { savedBytes, removed } or null.
 */
export function dedupImageContent(body) {
  try {
    const items = itemsOf(body);
    if (!items) return null;

    const seen = new Set();
    let savedBytes = 0;
    let removed = 0;

    for (const msg of items) {
      if (!msg || !Array.isArray(msg.content)) continue;
      const kept = [];
      for (const block of msg.content) {
        if (!block || typeof block !== "object") { kept.push(block); continue; }
        const sig = imageSignature(block);
        if (!sig) { kept.push(block); continue; }
        if (seen.has(sig)) {
          savedBytes += bytesOf(JSON.stringify(block));
          removed++;
          continue;
        }
        seen.add(sig);
        kept.push(block);
      }
      if (kept.length !== msg.content.length) msg.content = kept;
    }

    if (!removed) return null;
    return { savedBytes, removed };
  } catch {
    return null;
  }
}

function imageSignature(block) {
  if (block.type === "image" || block.type === "image_url" || block.type === "imageUrl") {
    const src = block.data || block.url || block.image_url?.url || block.source?.data;
    if (typeof src === "string") return src;
  }
  // OpenAI vision part: { type:"image_url", image_url:{ url } }
  if (typeof block.image_url === "string") return block.image_url;
  return null;
}

/**
 * Drop messages with empty / whitespace-only content (empty strings, empty
 * arrays, or objects with no meaningful fields). Returns { savedBytes, removed } or null.
 */
export function dropEmptyMessages(body) {
  try {
    const items = itemsOf(body);
    if (!items || items.length < 2) return null;

    const out = [];
    let savedBytes = 0;
    let removed = 0;
    for (const msg of items) {
      if (!msg) { out.push(msg); continue; }
      if (isEmptyMessage(msg)) {
        savedBytes += bytesOf(JSON.stringify(msg));
        removed++;
        continue;
      }
      out.push(msg);
    }
    if (!removed) return null;
    replaceItems(body, out);
    return { savedBytes, removed };
  } catch {
    return null;
  }
}

function isEmptyMessage(msg) {
  const c = msg.content;
  if (c === undefined || c === null) return false; // keep structural messages
  if (typeof c === "string") return c.trim().length === 0;
  if (Array.isArray(c)) {
    if (c.length === 0) return true;
    return c.every((p) => !p || (typeof p.text === "string" && p.text.trim().length === 0));
  }
  return false;
}

// Convenience log line, mirrors formatRtkLog style.
export function formatTrimmingLog(stats) {
  if (!stats) return null;
  return `[TRIMMING] saved ${stats.savedBytes}B removed=${stats.removed}`;
}
