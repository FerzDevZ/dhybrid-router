// Runner untuk embedded freebuff-proxy (fatmuh/freebuff-proxy) di dalam 9Router.
// Spawn process node dist/cli.js sebagai proses detached, identik dengan grokAutoRunner pattern.
// State disimpan di /tmp/freebuff_proxy_state.json
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getProviderConnections } from "@/lib/db/repos/connectionsRepo";

const STATE_FILE = "/tmp/freebuff_proxy_state.json";
const DEFAULT_PORT = parseInt(process.env.FREEBUFF_PROXY_PORT || "9187", 10);

/**
 * Temukan repo root — Next.js standalone server chdir ke .next/standalone,
 * jadi kita probe beberapa kandidat sampai ketemu folder scripts/freebuff-proxy.
 */
function findProxyDir() {
  const standaloneCandidate = "/home/firman/freebuff-proxy";
  if (fs.existsSync(path.join(standaloneCandidate, "package.json"))) {
    return standaloneCandidate;
  }
  const cwd = process.cwd();
  const candidates = [
    cwd,
    path.resolve(cwd, "..", ".."),
    path.resolve(cwd, ".."),
    "/home/firman/9router",
  ];
  for (const dir of candidates) {
    const candidatePath = path.join(dir, "scripts", "freebuff-proxy");
    if (fs.existsSync(path.join(candidatePath, "package.json"))) {
      return candidatePath;
    }
  }
  return path.join(cwd, "scripts", "freebuff-proxy");
}

const PROXY_DIR = findProxyDir();
const DIST_CLI = path.join(PROXY_DIR, "dist", "cli.js");

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { pid: null, port: DEFAULT_PORT, startedAt: null, stoppedAt: null, logFile: null };
  }
}

function saveState(s) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch { /* best-effort */ }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Cek apakah proxy sudah di-build */
export function isProxyBuilt() {
  return fs.existsSync(DIST_CLI);
}

/** Build proxy jika belum ada dist/cli.js */
export async function buildProxy() {
  if (isProxyBuilt()) return { ok: true, cached: true };
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", "build"], {
      cwd: PROXY_DIR,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (d) => { output += d.toString(); });
    child.stderr?.on("data", (d) => { output += d.toString(); });
    child.on("close", (code) => {
      if (code === 0) resolve({ ok: true, output });
      else resolve({ ok: false, error: `Build failed (exit ${code})`, output });
    });
    child.on("error", (err) => resolve({ ok: false, error: err.message }));
  });
}

export async function startFreebuffProxy({ port } = {}) {
  const state = loadState();
  const proxyPort = port || DEFAULT_PORT;

  if (pidAlive(state.pid)) {
    return { error: `Proxy sudah berjalan (PID ${state.pid}, port ${state.port})`, pid: state.pid, port: state.port };
  }

  // Pastikan proxy sudah di-build
  if (!isProxyBuilt()) {
    const buildResult = await buildProxy();
    if (!buildResult.ok) {
      return { error: `Build gagal: ${buildResult.error}` };
    }
  }

  const logFile = `/tmp/freebuff_proxy_${Date.now()}.log`;
  const out = fs.openSync(logFile, "a");

  const child = spawn("node", [DIST_CLI], {
    detached: true,
    stdio: ["ignore", out, out],
    cwd: PROXY_DIR,
    env: {
      ...process.env,
      LISTEN_ADDR: `0.0.0.0:${proxyPort}`,
      PORT: String(proxyPort),
      NODE_ENV: "production",
    },
  });
  child.unref();
  fs.closeSync(out);

  const s = { pid: child.pid, port: proxyPort, startedAt: new Date().toISOString(), stoppedAt: null, logFile };
  saveState(s);

  await new Promise((r) => setTimeout(r, 1500));
  if (!pidAlive(child.pid)) {
    const errLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").slice(-500) : "";
    return { error: `Proxy crash saat startup. Log: ${errLog}` };
  }

  return { success: true, pid: child.pid, port: proxyPort, logFile, startedAt: s.startedAt };
}

export function stopFreebuffProxy() {
  const state = loadState();
  if (!pidAlive(state.pid)) {
    saveState({ ...state, pid: null, stoppedAt: new Date().toISOString() });
    return { ok: true, alreadyStopped: true };
  }
  try {
    process.kill(-state.pid, "SIGTERM");
  } catch {
    try { process.kill(state.pid, "SIGTERM"); } catch { /* sudah mati */ }
  }
  saveState({ ...state, pid: null, stoppedAt: new Date().toISOString() });
  return { ok: true };
}

export function tailLog(logFile, n = 100) {
  try {
    const lines = fs.readFileSync(logFile, "utf8").split("\n");
    return lines.slice(-n).join("\n");
  } catch {
    return "";
  }
}

async function getTokenCount() {
  try {
    const conns = await getProviderConnections({ provider: "freebuff" });
    return conns.filter((c) => c.testStatus !== "error").length;
  } catch {
    return 0;
  }
}

async function checkProxyHealth(port) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export async function syncConnectionsToProxy(port = DEFAULT_PORT) {
  try {
    const conns = await getProviderConnections({ provider: "freebuff" });
    if (!conns || conns.length === 0) return;

    const res = await fetch(`http://127.0.0.1:${port}/api/accounts`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
    if (!res || !res.ok) return;

    const data = await res.json().catch(() => ({}));
    const existing = data.accounts || [];
    const existingTokens = new Set(existing.map((a) => a.token || a.auth_token));

    for (const conn of conns) {
      const token = conn.apiKey || conn.accessToken || "";
      if (token && !existingTokens.has(token)) {
        await fetch(`http://127.0.0.1:${port}/api/accounts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token,
            email: conn.email || conn.displayName || "9Router Account",
            name: conn.displayName || conn.email || "9Router Account",
          }),
          signal: AbortSignal.timeout(3000),
        }).catch(() => null);
      }
    }
  } catch {
    /* best-effort sync */
  }
}

function findProxyPid(port = DEFAULT_PORT) {
  try {
    const { execSync } = require("node:child_process");
    const out = execSync(`fuser ${port}/tcp 2>/dev/null || true`, { encoding: "utf8" }).trim();
    if (out) {
      const pids = out.split(/\s+/).map((p) => parseInt(p, 10)).filter(Boolean);
      if (pids.length > 0) return pids[0];
    }
  } catch {}
  return null;
}

export async function freebuffProxyStatus() {
  const state = loadState();
  const proxyPort = state.port || DEFAULT_PORT;

  const healthy = await checkProxyHealth(proxyPort);
  let running = healthy || pidAlive(state.pid);
  let pid = state.pid;

  if (healthy && (!pid || !pidAlive(pid))) {
    pid = findProxyPid(proxyPort) || state.pid;
    if (pid) {
      saveState({ ...state, pid, port: proxyPort, startedAt: state.startedAt || new Date().toISOString() });
    }
  }

  const logFile = (state.logFile && fs.existsSync(state.logFile))
    ? state.logFile
    : (fs.existsSync("/tmp/freebuff_proxy.log") ? "/tmp/freebuff_proxy.log" : null);

  if (running) {
    syncConnectionsToProxy(proxyPort).catch(() => null);
  }

  const rawConns = await getProviderConnections({ provider: "freebuff" }).catch(() => []);
  const activeConns = (rawConns || []).filter((c) => c.isActive === 1 || c.isActive === true);

  const connections = activeConns.map((c) => {
    const d = typeof c.data === "string" ? JSON.parse(c.data || "{}") : (c.data || {});
    return {
      id: c.id,
      name: c.email || c.displayName || c.name || d.providerSpecificData?.name,
      email: c.email || c.displayName || c.name || d.providerSpecificData?.email,
      status: c.testStatus === "error" ? "error" : "ready",
      proxyUrl: d.proxyUrl || d.providerSpecificData?.proxyUrl || null,
    };
  });

  return {
    running,
    healthy,
    pid: running ? pid : null,
    port: proxyPort,
    startedAt: state.startedAt,
    stoppedAt: state.stoppedAt,
    logTail: tailLog(logFile, running ? 80 : 30),
    logFile: logFile || "/tmp/freebuff_proxy.log",
    tokenCount: activeConns.length,
    built: isProxyBuilt(),
    proxyDir: PROXY_DIR,
    connections,
  };
}

export async function autoBalanceFreebuffProxies() {
  try {
    const { getDb } = await import("@/lib/db");
    const db = await getDb();
    const rawConns = await getProviderConnections({ provider: "freebuff" });
    const activeConns = (rawConns || []).filter((c) => c.isActive === 1 || c.isActive === true);
    if (!activeConns || activeConns.length === 0) return { ok: true, count: 0 };

    const proxyCandidates = [
      path.join(REPO_ROOT, "..", "ferz-auto-education", "suite", "active_socks5.txt"),
      path.join(REPO_ROOT, "..", "Auto-FreeCF", "suite", "active_socks5.txt"),
      "/home/firman/ferz-auto-education/suite/active_socks5.txt",
      "/home/firman/Auto-FreeCF/suite/active_socks5.txt"
    ];
    let liveProxies = [];
    for (const p of proxyCandidates) {
      if (fs.existsSync(p)) {
        const lines = fs.readFileSync(p, "utf8").split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#") && l.includes("://"));
        if (lines.length > 0) { liveProxies = lines; break; }
      }
    }

    let count = 0;
    for (let i = 0; i < activeConns.length; i++) {
      const c = activeConns[i];
      const assignedProxy = liveProxies.length > 0 ? liveProxies[i % liveProxies.length] : null;
      const data = typeof c.data === "string" ? JSON.parse(c.data || "{}") : (c.data || {});

      data.proxyUrl = assignedProxy;
      if (data.providerSpecificData) {
        data.providerSpecificData.proxyUrl = assignedProxy;
      }
      data.testStatus = "active";
      data.lastError = null;
      data.errorCode = null;

      await db.run("UPDATE providerConnections SET data = ?, isActive = 1 WHERE id = ?", [
        JSON.stringify(data),
        c.id,
      ]);

      if (assignedProxy) {
        try {
          const cleanPx = assignedProxy.replace("socks5://", "").replace("http://", "").replace("https://", "");
          const [host, port] = cleanPx.split(":");
          const pxRes = await fetch("http://127.0.0.1:9187/api/proxies", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: `AutoBalance-${c.email || c.name}`,
              type: assignedProxy.includes("socks5") ? "socks5" : "http",
              host,
              port: parseInt(port, 10),
            }),
            signal: AbortSignal.timeout(2000),
          });
          const pxData = await pxRes.json().catch(() => ({}));
          const proxyId = pxData?.proxy?.id || "";

          await fetch("http://127.0.0.1:9187/api/accounts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              token: c.apiKey || c.accessToken || data.accessToken,
              email: c.email || c.name,
              name: c.displayName || c.email || c.name,
              proxy_id: proxyId,
            }),
            signal: AbortSignal.timeout(2000),
          });
        } catch {}
      }

      count++;
    }
    return { ok: true, count };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

