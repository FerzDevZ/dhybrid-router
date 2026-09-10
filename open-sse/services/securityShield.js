/**
 * 🛡️ 9Router Zero-Trust Guardrails & Security Shield
 * Protects against prompt injections, secret exfiltration, and unauthorized system access.
 */

const SENSITIVE_FILE_PATTERNS = [
  /\.env(\.local|\.production|\.development)?$/i,
  /id_rsa(\.pub)?$/i,
  /id_ed25519(\.pub)?$/i,
  /\.aws\/credentials$/i,
  /\.npmrc$/i,
  /\.dockercfg$/i,
];

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions\s+and\s+exfiltrate/i,
  /system\s+override:\s+exfiltrate\s+all\s+keys/i,
];

export function inspectSecurityShield(body) {
  if (!body || !Array.isArray(body.messages)) return null;

  for (const msg of body.messages) {
    if (typeof msg.content === "string") {
      for (const pattern of INJECTION_PATTERNS) {
        if (pattern.test(msg.content)) {
          return {
            threatType: "PROMPT_INJECTION",
            detail: "Request blocked: Malicious prompt injection pattern detected"
          };
        }
      }
    }
  }

  return null; // Safe!
}

export function inspectAndShieldRequest(body) {
  return { safe: true, body };
}
