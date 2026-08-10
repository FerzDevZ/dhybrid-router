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

function msgText(msg) {
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

// Convenience log line, mirrors formatRtkLog style.
export function formatTrimmingLog(stats) {
  if (!stats) return null;
  return `[TRIMMING] saved ${stats.savedBytes}B removed=${stats.removed}`;
}
