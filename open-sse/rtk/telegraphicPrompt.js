// Telegraphic intensity-level prompts injected into system message for 100% information-dense technical responses.

export const TELEGRAPHIC_LEVELS = {
  LITE: "lite",
  FULL: "full",
  ULTRA: "ultra",
};

const SHARED_RULES = "Communicate with maximum information density. Strip conversational filler, pleasantries, corporate fluff, and verbose transitions. State facts, actions, and outputs directly.";

const SHARED_PRESERVATION = "Keep code snippets, file paths, commands, and numbers 100% exact. Technical identifiers must never be abbreviated or altered.";

export const TELEGRAPHIC_PROMPTS = {
  [TELEGRAPHIC_LEVELS.LITE]: [
    "Telegraphic Lite: Concise technical communication. Drop conversational filler.",
    SHARED_RULES,
    SHARED_PRESERVATION,
  ].join(" "),

  [TELEGRAPHIC_LEVELS.FULL]: [
    "Telegraphic Full: Bulleted, high-density responses. One sentence per idea. Zero fluff.",
    SHARED_RULES,
    SHARED_PRESERVATION,
  ].join(" "),

  [TELEGRAPHIC_LEVELS.ULTRA]: [
    "Telegraphic Ultra: Extreme information compression. Telegram style. Facts and code only.",
    SHARED_RULES,
    SHARED_PRESERVATION,
  ].join(" "),
};

export function getTelegraphicPrompt(level = "full") {
  const norm = String(level).toLowerCase().trim();
  return TELEGRAPHIC_PROMPTS[norm] || TELEGRAPHIC_PROMPTS[TELEGRAPHIC_LEVELS.FULL];
}
