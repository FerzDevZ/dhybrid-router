/**
 * 🩺 9Router Proactive Account Health & Token Heartbeat Service
 * Periodically audits provider connections, refreshes expiring access tokens,
 * and maintains quarantine state for accounts hitting 429/402 errors.
 */

import { listProviderConnections, upsertProviderConnection } from "../../src/lib/db/repos/connectionsRepo.js";
import { refreshProviderCredentials } from "./refresh.js";

const QUARANTINE_MAP = new Map(); // connectionId -> timestamp expires

export function quarantineAccount(connectionId, durationMs = 15 * 60 * 1000, reason = "429 Rate Limit") {
  const expiresAt = Date.now() + durationMs;
  QUARANTINE_MAP.set(connectionId, { expiresAt, reason });
  console.log(`⚠️ [AccountHealth] Quarantining connection ${connectionId} for ${durationMs / 1000}s (${reason})`);
}

export function isAccountQuarantined(connectionId) {
  if (!QUARANTINE_MAP.has(connectionId)) return false;
  const data = QUARANTINE_MAP.get(connectionId);
  if (Date.now() > data.expiresAt) {
    QUARANTINE_MAP.delete(connectionId);
    return false;
  }
  return true;
}

export async function runProactiveHealthCheck(log) {
  try {
    const connections = await listProviderConnections();
    if (!connections || !Array.isArray(connections)) return;

    const now = Date.now();
    for (const conn of connections) {
      if (conn.isActive === false) continue;

      // Check quarantine expiry
      if (isAccountQuarantined(conn.id)) {
        continue;
      }

      // Proactive Token Refresh (if expires in less than 15 minutes)
      const expiresAt = conn.credentials?.expiresAt || conn.credentials?.expires_at;
      if (expiresAt) {
        const expTime = typeof expiresAt === "string" ? new Date(expiresAt).getTime() : expiresAt;
        const diffMs = expTime - now;
        if (diffMs > 0 && diffMs < 15 * 60 * 1000) {
          if (log && log.info) log.info("HEALTH_CHECK", `Refreshing near-expiry token for provider: ${conn.provider}`);
          try {
            await refreshProviderCredentials(conn.provider, conn.credentials, log);
          } catch (err) {
            console.error(`[-] Proactive refresh failed for ${conn.provider}: ${err.message}`);
          }
        }
      }
    }
  } catch (err) {
    console.error(`[-] Proactive health check encountered error: ${err.message}`);
  }
}

// Background Cron: Run every 10 minutes
let heartbeatInterval = null;
export function startHealthHeartbeat(log) {
  if (heartbeatInterval) return;
  heartbeatInterval = setInterval(() => {
    runProactiveHealthCheck(log);
  }, 10 * 60 * 1000);
}
