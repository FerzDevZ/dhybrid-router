import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function rowToPool(row) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  return {
    ...extra,
    id: row.id,
    isActive: row.isActive === 1 || row.isActive === true,
    testStatus: row.testStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function poolToRow(p) {
  const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
  return {
    id,
    isActive: isActive === false ? 0 : 1,
    testStatus: testStatus ?? null,
    data: stringifyJson(rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, p) {
  const r = poolToRow(p);
  db.run(
    `INSERT INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       isActive=excluded.isActive, testStatus=excluded.testStatus,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.isActive, r.testStatus, r.data, r.createdAt, r.updatedAt]
  );
}

export async function getProxyPools(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
  if (filter.testStatus) { where.push("testStatus = ?"); params.push(filter.testStatus); }
  const sql = `SELECT * FROM proxyPools${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const list = db.all(sql, params).map(rowToPool);
  list.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  return list;
}

export async function getProxyPoolById(id) {
  const db = await getAdapter();
  return rowToPool(db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]));
}

export async function createProxyPool(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const pool = {
    id: data.id || uuidv4(),
    name: data.name,
    proxyUrl: data.proxyUrl,
    noProxy: data.noProxy || "",
    type: data.type || "http",
    isActive: data.isActive !== undefined ? data.isActive : true,
    strictProxy: data.strictProxy === true,
    // Failover + fallback policy
    maxFailover: data.maxFailover ?? 2,
    allowFallbackDirect: data.allowFallbackDirect !== false,
    priority: data.priority ?? 50,
    maxConcurrency: data.maxConcurrency ?? 0,
    weight: data.weight ?? 0,
    // Labels + safety
    tags: data.tags || "",
    autoUnbind: data.autoUnbind !== false,
    testStatus: data.testStatus || "unknown",
    lastTestedAt: data.lastTestedAt || null,
    lastError: data.lastError || null,
    // Health metrics (circuit breaker + observability)
    requestCount: data.requestCount || 0,
    successCount: data.successCount || 0,
    failCount: data.failCount || 0,
    avgLatencyMs: data.avgLatencyMs ?? null,
    lastLatencyMs: data.lastLatencyMs ?? null,
    consecutiveFailures: data.consecutiveFailures || 0,
    cooldownUntil: data.cooldownUntil || null,
    createdAt: now,
    updatedAt: now,
  };
  upsert(db, pool);
  return pool;
}

export async function updateProxyPool(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToPool(row), ...data, updatedAt: new Date().toISOString() };
    upsert(db, merged);
    result = merged;
  });
  return result;
}

export async function deleteProxyPool(id) {
  const db = await getAdapter();
  let removed = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM proxyPools WHERE id = ?`, [id]);
    if (!row) return;
    removed = rowToPool(row);
    db.run(`DELETE FROM proxyPools WHERE id = ?`, [id]);
  });
  return removed;
}
