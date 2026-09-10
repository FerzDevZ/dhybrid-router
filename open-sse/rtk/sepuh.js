import { injectSystemPrompt } from "./systemInject.js";
import { getSepuhPrompt } from "./sepuhPrompt.js";

export function injectSepuh(body, format, level = "full") {
  const prompt = getSepuhPrompt(level);
  injectSystemPrompt(body, format, prompt);
}
