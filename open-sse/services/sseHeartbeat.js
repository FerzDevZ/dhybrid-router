/**
 * 💓 9Router SSE Heartbeat Keep-Alive Emitter
 * Prevents 504 Gateway Timeouts, Cloudflare proxy drops, and idle socket terminations
 * by emitting lightweight SSE comment pings (": keep-alive\n\n") while upstream model is thinking.
 */

export function attachHeartbeat(readableStream, intervalMs = 6000) {
  let timer = null;
  const encoder = new TextEncoder();

  const transformStream = new TransformStream({
    start(controller) {
      // Start periodic heartbeat
      timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
        }
      }, intervalMs);
    },
    transform(chunk, controller) {
      // When actual data chunks arrive, forward immediately
      controller.enqueue(chunk);
    },
    flush() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }
  });

  return readableStream.pipeThrough(transformStream);
}
