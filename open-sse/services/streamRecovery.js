/**
 * ⚡ 9Router Stream Recovery & Auto-Stitch Buffer
 * Maintains sliding token buffer for active completions.
 * If upstream disconnects prematurely (error 499/502/abort),
 * seamlessly stitches recovery tokens so the client connection remains unbroken.
 */

export class StreamRecoveryBuffer {
  constructor(reqId, maxBufferSize = 2048) {
    this.reqId = reqId;
    this.maxBufferSize = maxBufferSize;
    this.chunks = [];
    this.totalText = "";
    this.totalReasoning = "";
    this.toolCalls = [];
    this.hasFinished = false;
  }

  appendChunk(chunk) {
    if (!chunk) return;
    this.chunks.push(chunk);

    // Track text delta
    const content = chunk.choices?.[0]?.delta?.content || "";
    if (content) {
      this.totalText += content;
    }

    // Track reasoning delta
    const reasoning = chunk.choices?.[0]?.delta?.reasoning_content || chunk.choices?.[0]?.delta?.reasoning || "";
    if (reasoning) {
      this.totalReasoning += reasoning;
    }

    // Track finish reason
    const finish = chunk.choices?.[0]?.finish_reason;
    if (finish && finish !== "null") {
      this.hasFinished = true;
    }
  }

  isTruncated() {
    return !this.hasFinished && this.totalText.length > 0;
  }

  getLastTextSlice(length = 200) {
    return this.totalText.slice(-length);
  }

  getContinuationPrompt() {
    const trailing = this.getLastTextSlice(120);
    return `[SYSTEM INSTRUCTION: Your previous response stream was interrupted. You were in the middle of writing: "${trailing}". Continue seamlessly from the exact next word or character without repeating any text.]`;
  }
}

const activeBuffers = new Map();

export function getOrCreateStreamBuffer(reqId) {
  if (!activeBuffers.has(reqId)) {
    activeBuffers.set(reqId, new StreamRecoveryBuffer(reqId));
  }
  return activeBuffers.get(reqId);
}

export function removeStreamBuffer(reqId) {
  activeBuffers.delete(reqId);
}
