import { injectSystemPrompt } from "./systemInject.js";
import { getTelegraphicPrompt } from "./telegraphicPrompt.js";

export function injectTelegraphic(body, format, level = "full") {
  const prompt = getTelegraphicPrompt(level);
  injectSystemPrompt(body, format, prompt);
}
