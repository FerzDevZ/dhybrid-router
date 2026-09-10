import { injectSystemPrompt } from "./systemInject.js";
import { getZenCoderPrompt } from "./zencoderPrompt.js";

export function injectZenCoder(body, format, level = "full") {
  const prompt = getZenCoderPrompt(level);
  injectSystemPrompt(body, format, prompt);
}
