/**
 * Precision Coding Directives & Fluff Stripper
 * Enforces razor-sharp, dense, zero-fluff coding and debugging output across all models.
 */

import { injectSystemPrompt } from "./systemInject.js";

// ── System Prompt: Short, sharp, concrete ───────────────────────────────────
// Long prompts are ignored by models. Keep it under 200 words with concrete
// examples of forbidden vs. required phrasing.

export const PRECISION_CODING_PROMPT = `[CRITICAL EXECUTION PROTOCOL — ELITE PROFESSIONAL SWE AGENT]

RULE 1 — TRUTHFUL COMPLETION STATUS:
- Only claim files were modified/written if you actually invoked write_file/patch tools in this turn.
- If you are providing analysis, recommendations, or planning: clearly present the plan/recommendations directly.

RULE 2 — RESPECT USER INTENT (PLANNING vs. IMPLEMENTATION):
- When the user asks to PLAN, DESIGN, or ANALYZE ("susun planning", "review", "ada saran", "jelaskan"): Provide a clean, structured, high-signal architectural plan or explanation directly in text.
- When the user asks to IMPLEMENT or CODE ("buatkan file", "perbaiki", "tulis kodenya"): Invoke the appropriate tools directly instead of dumping raw code in chat.

RULE 3 — CONCISE, HIGH-SIGNAL REASONING (ANTI-TIMEOUT):
- Keep internal reasoning concise, linear, and strictly under 300 words.
- Do NOT simulate dozens of complete source code files in mental reasoning (causes 300s timeout errors).

RULE 4 — ZERO MARKETING & FLUFF:
- No sycophantic corporate fluff or unnecessary small talk. Deliver dense, high-signal engineering output.`;

/**
 * Injects precision coding directives into request body and tunes sampling parameters.
 * @param {object} body - Request body
 * @param {string} format - Target or source format
 * @param {object} options - Options
 */
export function injectPrecisionDirectives(body, format, options = {}) {
  if (!body) return body;

  // 1. Inject prompt directives into system instruction
  injectSystemPrompt(body, format, PRECISION_CODING_PROMPT);

  // 2. Tune deterministic sampling for coding if not explicitly forced by client
  if (options.tuneSampling !== false) {
    if (body.temperature === undefined || body.temperature > 0.4) {
      body.temperature = 0.1;
    }
    if (body.top_p === undefined || body.top_p > 0.95) {
      body.top_p = 0.95;
    }
  }

  return body;
}

// ── Conversational fluff patterns ───────────────────────────────────────────

const LEADING_FLUFF_PATTERNS = [
  // English
  /^(?:sure!?|certainly!?|of course!?|here(?:'s| is) (?:the |your )?(?:code|updated|fixed|solution|file|implementation|script)[^:\n]*:?\s*)/i,
  /^(?:i (?:have |'ve )?(?:updated|fixed|modified|created|refactored|added)[^:\n]*:?\s*)/i,
  /^(?:below is (?:the |your )?(?:code|solution|updated|implementation)[^:\n]*:?\s*)/i,
  /^(?:hello!?|hi!?|hey!?|greetings!?)[\s,]+(?:here is|let me|i will)[^:\n]*:?\s*/i,
  // Indonesian
  /^(?:baik!?|oke!?|siap!?|tentu!?)\s*[,.]?\s*(?:saya akan|berikut|ini dia)[^:\n]*:?\s*/i,
  /^(?:saran\s+optimasi[^:]*yang\s+sudah\s+saya\s+terapkan[^:]*:?\s*)/i,
  /^(?:✅\s*)?(?:saran|optimasi|perubahan)[^:]*(?:sudah|telah)\s+(?:saya\s+)?(?:terapkan|implementasikan|buatkan)[^:]*:?\s*/i,
  /^(?:Sudah\s+jadi!?\s*)/i,
];

const TRAILING_FLUFF_PATTERNS = [
  // English
  /(?:\n\n|\n)(?:let me know if (?:you (?:have any questions|need (?:any )?(?:further |more )?(?:help|adjustments|changes|assistance))|this works for you)[^.]*\.?\s*)$/i,
  /(?:\n\n|\n)(?:hope this helps!?|feel free to ask if you have any questions!?)\s*$/i,
  // Indonesian
  /(?:\n\n|\n)(?:ada\s+(?:saran|pertanyaan)\s+(?:lain|tambahan)\s*\??)\s*$/i,
  /(?:\n\n|\n)(?:bisa\s+saya\s+lanjut(?:kan)?\s+ke\s+bagian\s+lain\??\s*(?:misalnya:?\s*)?)/i,
  /(?:\n\n|\n)(?:langsung\s+bilang\s+saja[^.]*\.?\s*)$/i,
  /(?:\n\n|\n)(?:kalau\s+tidak\s+ada\s+error[^.]*(?:berhasil\s+diterapkan)?[^.]*\.?\s*)$/i,
  /(?:\n\n|\n)(?:Mau\s+versi\s+yang\s+lebih[^.]*\.?\s*)$/is,
  /(?:\n\n|\n)(?:Bilang\s+aja,?\s*saya\s+buatkan[^.]*\.?\s*)$/is,
];

/**
 * Strips common conversational filler and sales fluff from text output
 * @param {string} text
 * @returns {string} Cleaned text
 */
export function stripConversationalFluff(text) {
  if (typeof text !== "string" || !text) return text;

  let cleaned = text.trim();

  // Strip leading conversational fluff
  for (const pat of LEADING_FLUFF_PATTERNS) {
    cleaned = cleaned.replace(pat, "").trim();
  }

  // Strip trailing conversational and marketing fluff
  for (const pat of TRAILING_FLUFF_PATTERNS) {
    cleaned = cleaned.replace(pat, "").trim();
  }

  // Strip leading raw HTML boilerplate dump if accompanied by a summary
  if (/^(?:html\s+)?<!DOCTYPE\s+html[\s\S]*?<\/html>\s*/i.test(cleaned)) {
    const withoutHtml = cleaned.replace(/^(?:html\s+)?<!DOCTYPE\s+html[\s\S]*?<\/html>\s*/i, "").trim();
    if (withoutHtml.length > 0) {
      cleaned = withoutHtml;
    }
  }

  return cleaned;
}
