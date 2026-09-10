import { DefaultExecutor } from "./default.js";

const PROXY_BASE_URL = process.env.FREEBUFF_PROXY_URL || "http://127.0.0.1:9187/v1";

const FALLBACK_MODEL_CHAIN = {
  "deepseek/deepseek-v4-flash": ["mimo/mimo-v2.5", "minimax/minimax-m2.7"],
  "mimo/mimo-v2.5": ["deepseek/deepseek-v4-flash", "minimax/minimax-m2.7"],
  "z-ai/glm-5.2": ["deepseek/deepseek-v4-flash", "mimo/mimo-v2.5"],
  "openai/gpt-5.6-luna": ["deepseek/deepseek-v4-flash", "mimo/mimo-v2.5"],
  "anthropic/claude-fable-5": ["deepseek/deepseek-v4-flash", "mimo/mimo-v2.5"],
  "minimax/minimax-m3": ["minimax/minimax-m2.7", "deepseek/deepseek-v4-flash"],
};

const SENSITIVE_PATTERNS = [
  { regex: /\bsk-[a-zA-Z0-9]{32,}\b/g, replace: "[REDACTED_OPENAI_KEY]" },
  { regex: /\bsk-proj-[a-zA-Z0-9_-]{32,}\b/g, replace: "[REDACTED_PROJECT_KEY]" },
  { regex: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: "[REDACTED_AWS_KEY]" },
  { regex: /\bghp_[a-zA-Z0-9]{36}\b/g, replace: "[REDACTED_GITHUB_TOKEN]" },
  { regex: /\bgithub_pat_[a-zA-Z0-9_]{30,}\b/g, replace: "[REDACTED_GITHUB_PAT]" },
  { regex: /\bglpat-[a-zA-Z0-9_-]{20,}\b/g, replace: "[REDACTED_GITLAB_TOKEN]" },
  { regex: /(postgres|mysql|mongodb(\+srv)?):\/\/[^:\s]+:[^@\s]+@[^\s]+/gi, replace: "[REDACTED_DATABASE_URI]" },
  { regex: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, replace: "[REDACTED_PRIVATE_KEY]" },
];

/**
 * FreebuffExecutor — routes chat completions through the local fatmuh/freebuff-proxy
 * Supports: ferz/* prefix branding, natural developer prompts, and security redacting.
 * Compatible with BaseExecutor interface: execute({model,body,stream,credentials,signal,log,proxyOptions})
 */
export class FreebuffExecutor extends DefaultExecutor {
  constructor(provider = "freebuff") {
    super(provider);
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const customBase = credentials?.providerSpecificData?.baseUrl;
    if (customBase) {
      const base = String(customBase || "").replace(/\/$/, "").replace(/\/chat\/completions$/, "");
      return `${base}/chat/completions`;
    }
    return `${PROXY_BASE_URL}/chat/completions`;
  }

  buildHeaders(credentials, stream = true) {
    // Freebuff proxy is local and does not require auth headers;
    // still provide minimal headers to satisfy upstream.
    return {
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
      Connection: "keep-alive",
    };
  }

  // Keep compatibility with old positional call if any external code uses it
  async execute(argsOrModel, body, stream, credentials, signalOrHeaders) {
    // Detect object-style call from BaseExecutor contract
    if (argsOrModel && typeof argsOrModel === "object" && "body" in argsOrModel) {
      const { model, body: reqBody, stream: reqStream, credentials: creds, signal, log, proxyOptions } = argsOrModel;
      // Optional small jitter (50-120ms) abort-aware to avoid burst detection, not blocking on abort
      if (signal?.aborted) throw Object.assign(new Error("AbortError"), { name: "AbortError" });
      const jitter = 50 + Math.floor(Math.random() * 70);
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, jitter);
        if (signal) signal.addEventListener("abort", () => { clearTimeout(t); reject(Object.assign(new Error("AbortError"), { name: "AbortError" })); }, { once: true });
      }).catch((e) => { if (e.name === "AbortError") throw e; });
      return super.execute({ model, body: reqBody, stream: reqStream, credentials: creds || {}, signal, log, proxyOptions });
    }
    // Legacy positional fallback: execute(model, body, stream, credentials, originalHeaders)
    const model = argsOrModel;
    const jitter = 50 + Math.floor(Math.random() * 70);
    await new Promise((r) => setTimeout(r, jitter));
    return super.execute({ model, body, stream, credentials: credentials || {}, signal: null, log: null, proxyOptions: null });
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);

    // Safe string conversion and ferz/* prefix mapping
    const modelStr = typeof transformed.model === "string" ? transformed.model : (typeof model === "string" ? model : String(model || ""));
    let targetModel = modelStr
      .replace(/^freebuff\//, "")
      .replace(/^ferz\//, "");

    // Map model alias shortcuts to exact upstream IDs
    const MODEL_ALIASES = {
      "mimo-2.5": "mimo/mimo-v2.5",
      "mimo": "mimo/mimo-v2.5",
      "glm-5.2": "z-ai/glm-5.2",
      "minimax-abab7": "minimax/minimax-m2.7",
      "minimax-m2.7": "minimax/minimax-m2.7",
      "gpt-5.6": "openai/gpt-5.6-luna",
      "claude-fable": "anthropic/claude-fable-5",
    };
    if (MODEL_ALIASES[targetModel]) {
      targetModel = MODEL_ALIASES[targetModel];
    }

    // 1. Intent-Based Model Auto-Classifier
    if (targetModel === "auto" || targetModel === "ferz/auto" || targetModel === "freebuff/auto") {
      const fullText = (transformed.messages || []).map((m) => (typeof m.content === "string" ? m.content : typeof m.content === "object" ? JSON.stringify(m.content) : "")).join(" ").toLowerCase();
      if (/math|formula|equation|proof|matrix|solve|calculate|algorithm/i.test(fullText)) {
        targetModel = "z-ai/glm-5.2";
      } else if (/explain|summarize|documentation|translate|write docs/i.test(fullText)) {
        targetModel = "minimax/minimax-m2.7";
      } else if (fullText.length < 120 && !/function|def|const|class/i.test(fullText)) {
        targetModel = "mimo/mimo-v2.5";
      } else {
        targetModel = "deepseek/deepseek-v4-flash";
      }
    }
    transformed.model = targetModel;

    // 2. Security Gatekeeper & Chat History Deduplication & Lockfile / Log Noise Slimmer
    if (Array.isArray(transformed.messages)) {
      const seenCodeHashes = new Set();

      transformed.messages = transformed.messages.map((msg, idx) => {
        if (typeof msg.content !== "string") return msg;
        let content = msg.content;

        // Security Gatekeeper: Redact sensitive keys and DB URIs
        for (const { regex, replace } of SENSITIVE_PATTERNS) {
          // Reset lastIndex for global regex reuse
          regex.lastIndex = 0;
          content = content.replace(regex, replace);
        }

        // Slim down huge lockfiles – use non-greedy and size-limited to avoid catastrophic backtrack
        if (content.length < 500000 && (content.includes('"lockfileVersion"') || content.includes('yarn lockfile v1') || content.includes('lockfileVersion:'))) {
          content = content.replace(/("dependencies":\s*\{[\s\S]{0,20000}?\})|("packages":\s*\{[\s\S]{0,20000}?\})/g, '"[Lockfile dependencies slimmed by 9Router Token Saver]"');
        }

        // Collapse excessive newlines & trailing whitespace
        content = content.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");

        // Deduplicate repeated code blocks in past user/assistant messages
        if (idx < transformed.messages.length - 1 && content.length > 800) {
          const simpleHash = content.slice(0, 300);
          if (seenCodeHashes.has(simpleHash)) {
            content = "[Prior code snippet omitted by 9Router Deduplication to save tokens]";
          } else {
            seenCodeHashes.add(simpleHash);
          }
        }

        return { ...msg, content };
      });
    }

    return transformed;
  }

  transformResponse(response, credentials) {
    return response;
  }
}

export default FreebuffExecutor;
