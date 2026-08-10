// Token Saver mode presets: quick-set off/low/full/super-power.
// Each mode maps to concrete per-feature values; applying writes them as real
// settings (no persistent override) so users can fine-tune afterwards.
export const SAVER_MODES = ["off", "lite", "full", "ultra"];

// Display names (lite → "Low", ultra → "Super-Power") + per-preset descriptions.
export const SAVER_MODE_LABELS = {
  off: "Off",
  lite: "Low",
  full: "Full",
  ultra: "Super-Power",
};

export const SAVER_MODE_DESCRIPTIONS = {
  off: "Semua saver mati — request dikirim apa adanya.",
  lite: "Hemat ringan & aman: RTK + dedup pesan + history trim (60KB).",
  full: "Seimbang & kuat: RTK + Headroom + Ponytail + dedup + trim (45KB) + summary (90KB) + force-truncate tool (40KB) + dedup gambar.",
  ultra: "Super-Power — semua saver + PXPIPE + headroom code-aware/kompress + advisor + force-truncate (30KB) + cap output. Paling agresif.",
};

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
    forceTruncateBytes: 40000,
    dedupImageContent: true,
    dropEmptyMessages: true,
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
    // Super-Power extras (all fail-open when not installed/available)
    pxpipeEnabled: true,
    pxpipeMinChars: 20000,
    headroomMinBytes: 2048,
    headroomCodeAware: true,
    headroomKompress: true,
    tokenSaverAdvisor: true,
    forceTruncateBytes: 30000,
    dedupImageContent: true,
    dropEmptyMessages: true,
    capOutputTokens: true,
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
