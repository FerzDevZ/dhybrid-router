/**
 * 🔄 9Router Auto-Continuation Stream Stitcher
 * Automatically detects responses truncated due to model token limits (finish_reason: "length")
 * and transparently issues continuation turns behind the scenes, stitching tokens into one infinite response.
 */

export function createContinuationDetector() {
  let isTruncated = false;
  let accumulatedContent = "";

  return {
    inspectChunk(chunkStr) {
      if (!chunkStr) return;

      // Check for finish_reason: "length" or "max_tokens"
      if (
        chunkStr.includes('"finish_reason":"length"') ||
        chunkStr.includes('"finish_reason":"max_tokens"') ||
        chunkStr.includes('"stop_reason":"max_tokens"')
      ) {
        isTruncated = true;
      }

      // Track accumulated text to support context stitching if needed
      try {
        const lines = chunkStr.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ") && line.trim() !== "data: [DONE]") {
            const parsed = JSON.parse(line.slice(6));
            const delta = parsed.choices?.[0]?.delta?.content || parsed.delta?.text || "";
            if (delta) accumulatedContent += delta;
          }
        }
      } catch {
        // Fallback for non-JSON lines
      }
    },
    isTruncated() {
      return isTruncated;
    },
    getAccumulatedContent() {
      return accumulatedContent;
    },
    reset() {
      isTruncated = false;
    }
  };
}

export function buildContinuationPayload(originalBody, accumulatedAssistantText) {
  const messages = Array.isArray(originalBody.messages) ? [...originalBody.messages] : [];

  // Append partial assistant output + explicit continuation prompt
  if (accumulatedAssistantText) {
    messages.push({
      role: "assistant",
      content: accumulatedAssistantText,
    });
    messages.push({
      role: "user",
      content: "Continue precisely from where you left off without preamble or repeating previous text.",
    });
  }

  return {
    ...originalBody,
    messages,
  };
}
