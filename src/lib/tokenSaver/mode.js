// Token Saver mode presets: quick-set off/lite/full/ultra.
// Each mode maps to concrete per-feature values; applying writes them as real
// settings (no persistent override) so users can fine-tune afterwards.
export const SAVER_MODES = ["off", "lite", "full", "ultra"];

export const MODE_PRESETS = {
  off: {
    rtkEnabled: false,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    dedupMessages: false,
    historyTrimMaxBytes: 0,
    summaryInject: false,
    headroomCompressUserMessages: false,
  },
  lite: {
    rtkEnabled: true,
    headroomEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    dedupMessages: true,
    historyTrimMaxBytes: 60000,
    historyTrimKeepMin: 6,
    summaryInject: false,
    headroomCompressUserMessages: false,
  },
  full: {
    rtkEnabled: true,
    headroomEnabled: true,
    cavemanEnabled: false,
    ponytailEnabled: true,
    ponytailLevel: "full",
    dedupMessages: true,
    historyTrimMaxBytes: 45000,
    historyTrimKeepMin: 6,
    summaryInject: true,
    summaryInjectAboveBytes: 90000,
    headroomCompressUserMessages: false,
  },
  ultra: {
    rtkEnabled: true,
    headroomEnabled: true,
    cavemanEnabled: true,
    cavemanLevel: "full",
    ponytailEnabled: true,
    ponytailLevel: "ultra",
    dedupMessages: true,
    historyTrimMaxBytes: 30000,
    historyTrimKeepMin: 4,
    summaryInject: true,
    summaryInjectAboveBytes: 60000,
    headroomCompressUserMessages: true,
  },
};

export function isSaverMode(mode) {
  return SAVER_MODES.includes(mode);
}

/**
 * Return the settings patch for a mode (unknown mode → {} so callers no-op).
 */
export function applySaverMode(mode) {
  return MODE_PRESETS[mode] || {};
}

/**
 * Detect the active mode from current settings by exact match against presets.
 * Returns "off"|"lite"|"full"|"ultra" — falls back to "custom" when the
 * combination matches no preset (user tweaked toggles manually).
 */
export function detectSaverMode(settings = {}) {
  for (const mode of SAVER_MODES) {
    const preset = MODE_PRESETS[mode];
    let match = true;
    for (const [key, value] of Object.entries(preset)) {
      // Missing keys count as "unset" → treat as the falsy default for that type
      const actual = settings[key] === undefined
        ? (typeof value === "number" ? 0 : false)
        : settings[key];
      if (actual !== value) { match = false; break; }
    }
    if (match) return mode;
  }
  return "custom";
}
