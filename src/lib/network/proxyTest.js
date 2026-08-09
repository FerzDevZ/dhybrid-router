import { ProxyAgent, fetch as undiciFetch } from "undici";

const DEFAULT_TEST_URL = "https://example.com/";
const DEFAULT_TIMEOUT_MS = 8000;

function getErrorMessage(err) {
  if (!err) return "Unknown error";
  const base = err?.message || String(err);
  const causeCode = err?.cause?.code || err?.code;
  const causeMessage = err?.cause?.message;

  if (causeMessage && causeMessage !== base) {
    return causeCode ? `${base}: ${causeMessage} (${causeCode})` : `${base}: ${causeMessage}`;
  }

  if (causeCode && !base.includes(causeCode)) {
    return `${base} (${causeCode})`;
  }

  return base;
}

function normalizeString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

// SOCKS proxies have no standard HTTP CONNECT — use socks-proxy-agent with
// a plain https.request (undici ProxyAgent only supports http(s) proxies).
function isSocksUrl(proxyUrl) {
  return /^socks(4|4a|5|5h)?:\/\//i.test(normalizeString(proxyUrl));
}

async function testViaSocks(proxyUrl, testUrl, timeoutMs) {
  const { SocksProxyAgent } = await import("socks-proxy-agent");
  const httpsModule = await import("https");
  const httpModule = await import("http");
  const https = httpsModule.default ?? httpsModule;
  const http = httpModule.default ?? httpModule;

  return new Promise((resolve) => {
    let agent;
    try {
      agent = new SocksProxyAgent(proxyUrl);
    } catch (err) {
      resolve({ ok: false, status: 400, error: `Invalid SOCKS URL: ${err?.message || String(err)}` });
      return;
    }

    const controller = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const urlObj = new URL(testUrl);
    const client = (urlObj.protocol === "https:" ? https : http).request(
      testUrl,
      {
        method: "HEAD",
        agent,
        headers: { "User-Agent": "9Router" },
        signal: controller.signal,
      },
      (res) => {
        clearTimeout(timer);
        res.resume();
        // Accept 2xx and 3xx (redirects mean connection works, target just moved)
        const ok = res.statusCode >= 200 && res.statusCode < 400;
        resolve({ ok, status: res.statusCode, statusText: res.statusMessage, url: testUrl, elapsedMs: Date.now() - startedAt });
      }
    );

    client.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        status: 500,
        error: err?.name === "AbortError" ? "Proxy test timed out" : getErrorMessage(err),
      });
    });
    client.end();
  });
}

export async function testProxyUrl({ proxyUrl, testUrl, timeoutMs } = {}) {
  const normalizedProxyUrl = normalizeString(proxyUrl);
  if (!normalizedProxyUrl) {
    return { ok: false, status: 400, error: "proxyUrl is required" };
  }

  const normalizedTestUrl = normalizeString(testUrl) || DEFAULT_TEST_URL;
  const timeoutMsRaw = Number(timeoutMs);
  const normalizedTimeoutMs =
    Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
      ? Math.min(timeoutMsRaw, 30000)
      : DEFAULT_TIMEOUT_MS;

  if (isSocksUrl(normalizedProxyUrl)) {
    return testViaSocks(normalizedProxyUrl, normalizedTestUrl, normalizedTimeoutMs);
  }

  let dispatcher;

  try {
    try {
      dispatcher = new ProxyAgent({ uri: normalizedProxyUrl });
    } catch (err) {
      return {
        ok: false,
        status: 400,
        error: `Invalid proxy URL: ${err?.message || String(err)}`,
      };
    }

    const controller = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(), normalizedTimeoutMs);

    try {
      const res = await undiciFetch(normalizedTestUrl, {
        method: "HEAD",
        dispatcher,
        signal: controller.signal,
        headers: {
          "User-Agent": "9Router",
        },
      });

      // Accept 2xx and 3xx (redirects mean connection works, target just moved)
      const ok = res.status >= 200 && res.status < 400;

      return {
        ok,
        status: res.status,
        statusText: res.statusText,
        url: normalizedTestUrl,
        elapsedMs: Date.now() - startedAt,
      };
    } catch (err) {
      const message =
        err?.name === "AbortError"
          ? "Proxy test timed out"
          : getErrorMessage(err);
      return { ok: false, status: 500, error: message };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    try {
      await dispatcher?.close?.();
    } catch {
      // ignore
    }
  }
}
