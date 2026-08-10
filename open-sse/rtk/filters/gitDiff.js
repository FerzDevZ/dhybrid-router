// Port of Rust git::compact_diff (src/cmds/git/git.rs L325-413)
// Compacts unified diff: file headers, hunk-level truncation at 100 lines, +/-/context counting
import { GIT_DIFF_HUNK_MAX_LINES, GIT_DIFF_CONTEXT_KEEP } from "../constants.js";

export function gitDiff(diff, maxLines = 500) {
  const result = [];
  let currentFile = "";
  let added = 0;
  let removed = 0;
  let inHunk = false;
  let hunkShown = 0;
  let hunkSkipped = 0;
  let wasTruncated = false;
  const maxHunkLines = GIT_DIFF_HUNK_MAX_LINES;
  const contextKeep = GIT_DIFF_CONTEXT_KEEP;
  // For context keeping: buffer lines before first change in a hunk
  let contextBuffer = [];

  const lines = diff.split("\n");

  outer: for (const line of lines) {
    if (line.startsWith("diff --git")) {
      if (hunkSkipped > 0) {
        result.push(`  ... (${hunkSkipped} lines truncated)`);
        wasTruncated = true;
        hunkSkipped = 0;
      }
      if (currentFile && (added > 0 || removed > 0)) {
        result.push(`  +${added} -${removed}`);
      }
      const parts = line.split(" b/");
      currentFile = parts.length > 1 ? parts.slice(1).join(" b/") : "unknown";
      result.push(`\n${currentFile}`);
      added = 0;
      removed = 0;
      inHunk = false;
      hunkShown = 0;
      contextBuffer = [];
    } else if (line.startsWith("@@")) {
      if (hunkSkipped > 0) {
        result.push(`  ... (${hunkSkipped} lines truncated)`);
        wasTruncated = true;
        hunkSkipped = 0;
      }
      // Flush context buffer before starting new hunk
      if (contextBuffer.length > 0) {
        const toKeep = contextBuffer.slice(-contextKeep);
        result.push(...toKeep);
        contextBuffer = [];
      }
      inHunk = true;
      hunkShown = 0;
      result.push(`  ${line}`);
    } else if (inHunk) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        added += 1;
        if (hunkShown < maxHunkLines) {
          // Flush context buffer before first change
          if (hunkShown === 0 && contextBuffer.length > 0) {
            const toKeep = contextBuffer.slice(-contextKeep);
            result.push(...toKeep);
            contextBuffer = [];
          }
          result.push(`  ${line}`);
          hunkShown += 1;
        } else {
          hunkSkipped += 1;
        }
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        removed += 1;
        if (hunkShown < maxHunkLines) {
          if (hunkShown === 0 && contextBuffer.length > 0) {
            const toKeep = contextBuffer.slice(-contextKeep);
            result.push(...toKeep);
            contextBuffer = [];
          }
          result.push(`  ${line}`);
          hunkShown += 1;
        } else {
          hunkSkipped += 1;
        }
      } else if (hunkShown < maxHunkLines && !line.startsWith("\\")) {
        if (hunkShown > 0) {
          result.push(`  ${line}`);
          hunkShown += 1;
        } else {
          // This is context before first change — buffer it
          if (contextBuffer.length >= contextKeep) contextBuffer.shift();
          contextBuffer.push(`  ${line}`);
        }
      }
    } else {
      // Not in a hunk — clear context buffer
      contextBuffer = [];
    }

    if (result.length >= maxLines) {
      result.push("\n... (more changes truncated)");
      wasTruncated = true;
      break outer;
    }
  }

  if (hunkSkipped > 0) {
    result.push(`  ... (${hunkSkipped} lines truncated)`);
    wasTruncated = true;
  }

  if (currentFile && (added > 0 || removed > 0)) {
    result.push(`  +${added} -${removed}`);
  }

  if (wasTruncated) {
    result.push("[full diff: rtk git diff --no-compact]");
  }

  return result.join("\n");
}

gitDiff.filterName = "git-diff";
