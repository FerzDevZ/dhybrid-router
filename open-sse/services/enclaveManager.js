/**
 * Project Enclave & Multi-Workspace Isolation Manager
 * Isolates semantic cache namespaces, usage metrics, and session history per project workspace.
 */

const enclaveStats = new Map();

/**
 * Resolve project enclave identifier from request headers or body metadata
 */
export function resolveProjectEnclave(reqHeaders = {}, body = {}) {
  const headerValue =
    reqHeaders["x-project-enclave"] ||
    reqHeaders["x-workspace-id"] ||
    reqHeaders["x-project-name"];

  if (headerValue && typeof headerValue === "string" && headerValue.trim()) {
    return headerValue.trim().toLowerCase();
  }

  if (body.project_id || body.workspace_id) {
    return String(body.project_id || body.workspace_id).trim().toLowerCase();
  }

  return "default";
}

/**
 * Track token usage per project enclave
 */
export function recordEnclaveUsage(enclaveId, tokensUsed = 0) {
  if (!enclaveId) return;
  const current = enclaveStats.get(enclaveId) || { totalRequests: 0, totalTokens: 0, lastActive: null };
  current.totalRequests += 1;
  current.totalTokens += tokensUsed;
  current.lastActive = new Date().toISOString();
  enclaveStats.set(enclaveId, current);
}

/**
 * Get summary of active project enclaves
 */
export function getEnclaveStatsSummary() {
  const result = [];
  for (const [id, stats] of enclaveStats.entries()) {
    result.push({ id, ...stats });
  }
  return result;
}
