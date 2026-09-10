/**
 * Task Analyzer for Dynamic Task-Aware Auto Routing
 * Analyzes request prompt complexity to decide routing target (cheap/fast vs heavy/reasoning)
 */

const COMPLEX_KEYWORDS = [
  "architect",
  "refactor",
  "system design",
  "benchmark",
  "security audit",
  "race condition",
  "deadlock",
  "memory leak",
  "algorithm",
  "performance tuning",
  "migration plan",
];

const SIMPLE_KEYWORDS = [
  "fix typo",
  "format json",
  "indent",
  "explain line",
  "syntax error",
  "rename variable",
  "add comment",
  "translate code",
];

/**
 * Analyze prompt complexity
 * @param {object} body - Chat request body
 * @returns {{ complexity: "simple" | "complex" | "medium", score: number, reason: string }}
 */
export function analyzeTaskComplexity(body) {
  if (!body) return { complexity: "medium", score: 50, reason: "Default body" };

  const messages = Array.isArray(body.messages) ? body.messages : [];
  let totalChars = 0;
  let codeBlockCount = 0;
  let textContent = "";

  for (const msg of messages) {
    if (!msg || !msg.content) continue;

    let contentStr = "";
    if (typeof msg.content === "string") {
      contentStr = msg.content;
    } else if (Array.isArray(msg.content)) {
      contentStr = msg.content.map(part => part?.text || "").join(" ");
    }

    totalChars += contentStr.length;
    textContent += " " + contentStr.toLowerCase();
    codeBlockCount += (contentStr.match(/```/g) || []).length / 2;
  }

  let score = 50;

  // Length heuristics
  if (totalChars < 350 && codeBlockCount <= 1) {
    score -= 30;
  } else if (totalChars > 1500 || codeBlockCount >= 3) {
    score += 35;
  }

  // Keyword match
  for (const kw of COMPLEX_KEYWORDS) {
    if (textContent.includes(kw)) {
      score += 25;
      break;
    }
  }

  for (const kw of SIMPLE_KEYWORDS) {
    if (textContent.includes(kw)) {
      score -= 20;
      break;
    }
  }

  if (score < 40) {
    return { complexity: "simple", score, reason: `Short payload (${totalChars} chars, ${codeBlockCount} codeblocks)` };
  }
  if (score > 65) {
    return { complexity: "complex", score, reason: `High complexity payload (${totalChars} chars, ${codeBlockCount} codeblocks)` };
  }
  return { complexity: "medium", score, reason: "Standard payload complexity" };
}

/**
 * Resolve target model for auto/smart-route
 * @param {string} modelStr
 * @param {object} body
 * @returns {{ targetModel: string, complexityInfo: object }}
 */
export function resolveAutoRouteModel(modelStr, body) {
  const norm = String(modelStr || "").toLowerCase().trim();
  if (norm !== "auto" && norm !== "smart-route" && norm !== "omni-route" && norm !== "smart-coder" && norm !== "fastest-coder" && norm !== "hermes-auto") {
    return { targetModel: modelStr, complexityInfo: null };
  }

  const info = analyzeTaskComplexity(body);
  let targetModel = "grok-cli/grok-build"; // Default fallback

  if (norm === "fastest-coder" || info.complexity === "simple") {
    targetModel = "ferz/deepseek/deepseek-v4-flash";
  } else if (info.complexity === "complex") {
    targetModel = "grok-cli/grok-4.6";
  } else {
    targetModel = "grok-cli/grok-build";
  }

  return { targetModel, complexityInfo: info };
}
