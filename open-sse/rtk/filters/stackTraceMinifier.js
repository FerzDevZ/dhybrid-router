// Stack Trace Minifier: compresses multi-page Node.js / Python stack traces down to
// the essential error message and relevant user application call frames.

const NODE_INTERNALS_RE = /^\s*at\s+(?:(?:node:)?internal\/|async\s+Module\.|processTicksAndRejections|runNextTicks|node_modules\/next\/dist\/)/m;
const PYTHON_INTERNALS_RE = /^\s*File\s+".*\/lib\/python\d\.\d+\/(?:asyncio|threading|logging|importlib)\//m;

export function isVerboseStackTrace(text) {
  if (typeof text !== "string" || text.length < 300) return false;
  const lineCount = (text.match(/\n/g) || []).length;
  return lineCount > 15 && (/Error:|\bTraceback \(most recent call last\):|\bat\s+.*\(/m.test(text));
}

export function minifyStackTrace(text) {
  if (!isVerboseStackTrace(text)) return text;

  const lines = text.split("\n");
  const filtered = [];
  let skippedCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Keep the main error header and user code lines
    const isNodeInternal = NODE_INTERNALS_RE.test(line);
    const isPythonInternal = PYTHON_INTERNALS_RE.test(line);

    if ((isNodeInternal || isPythonInternal) && i > 3) {
      skippedCount++;
      continue;
    }

    if (skippedCount > 0) {
      filtered.push(`    ... [${skippedCount} internal runtime frames omitted]`);
      skippedCount = 0;
    }
    filtered.push(line);
  }

  if (skippedCount > 0) {
    filtered.push(`    ... [${skippedCount} internal runtime frames omitted]`);
  }

  return filtered.join("\n");
}
