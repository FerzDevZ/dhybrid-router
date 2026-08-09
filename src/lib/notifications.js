// Fire-and-forget webhook notifications for operational events.
// Fail-open: no URL configured or any network error → silent no-op.
const WEBHOOK_URL = process.env.NOTIFICATION_WEBHOOK_URL || "";
const MIN_INTERVAL_MS = Number(process.env.NOTIFICATION_MIN_INTERVAL_MS || 5 * 60 * 1000) || 0;

// Dedupe per (event, scope) — a flooded provider must not spam the webhook.
const lastSentAt = new Map();

export function getNotificationWebhookUrl() {
  return WEBHOOK_URL;
}

/**
 * Send a notification if enabled and not throttled.
 * @param {string} event - e.g. "account_locked", "provider_all_locked", "api_key_limited"
 * @param {object} data - event payload (provider, connectionId, message, ...)
 */
export async function sendNotification(event, data = {}) {
  if (!WEBHOOK_URL) return;
  const now = Date.now();
  const scopeKey = [event, data.provider || "", data.connectionId || "", data.apiKey || "global"].filter(Boolean).join(":");
  if (now - (lastSentAt.get(scopeKey) || 0) < MIN_INTERVAL_MS) return;
  lastSentAt.set(scopeKey, now);
  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, ts: new Date().toISOString(), ...data }),
    });
  } catch {
    /* notifications must never break requests */
  }
}

export function resetNotificationThrottle() {
  lastSentAt.clear();
}
