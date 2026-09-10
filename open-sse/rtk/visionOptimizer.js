// Vision Token Optimizer: downsizes huge raw screenshots or base64 image data to
// optimal model vision limits (e.g. 1024x1024 or low-detail flags) to avoid massive vision token consumption.

/**
 * Optimizes OpenAI/Claude vision messages in-place.
 */
export function optimizeVisionPayload(body, enabled = true) {
  if (!enabled || !body || typeof body !== "object") return;

  const messages = Array.isArray(body.messages) ? body.messages
    : Array.isArray(body.input) ? body.input
    : null;
  if (!messages) return;

  for (const msg of messages) {
    if (!msg || !Array.isArray(msg.content)) continue;

    for (const part of msg.content) {
      if (!part || typeof part !== "object") continue;

      // OpenAI image_url object
      if (part.type === "image_url" && part.image_url) {
        if (typeof part.image_url === "object" && !part.image_url.detail) {
          // Default detail to auto/low to avoid 1440-token high-res expansion unless necessary
          part.image_url.detail = "auto";
        }
      }
    }
  }
}
