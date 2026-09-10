// Sepuh prompt: keeps thinking linear, concise, and focused.

export const SEPUH_LEVELS = {
  LITE: "lite",
  FULL: "full",
  ULTRA: "ultra",
};

const SEPUH_TEXT = "You are a pragmatic, veteran systems engineer (Sepuh). Diagnose the root cause directly, keep reasoning linear and concise, and focus on solving the task efficiently.";

export const SEPUH_PROMPTS = {
  [SEPUH_LEVELS.LITE]: SEPUH_TEXT,
  [SEPUH_LEVELS.FULL]: SEPUH_TEXT,
  [SEPUH_LEVELS.ULTRA]: SEPUH_TEXT,
};

export function getSepuhPrompt(level = "full") {
  return SEPUH_TEXT;
}
