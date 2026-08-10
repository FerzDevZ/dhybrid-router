import { describe, it, expect } from "vitest";
import { MODE_PRESETS, applySaverMode, detectSaverMode, SAVER_MODES } from "../../src/lib/tokenSaver/mode.js";

describe("applySaverMode", () => {
  it("off disables everything", () => {
    const patch = applySaverMode("off");
    expect(patch.rtkEnabled).toBe(false);
    expect(patch.headroomEnabled).toBe(false);
    expect(patch.cavemanEnabled).toBe(false);
    expect(patch.ponytailEnabled).toBe(false);
    expect(patch.dedupMessages).toBe(false);
    expect(patch.historyTrimMaxBytes).toBe(0);
    expect(patch.summaryInject).toBe(false);
  });

  it("lite enables rtk + dedup only", () => {
    const patch = applySaverMode("lite");
    expect(patch.rtkEnabled).toBe(true);
    expect(patch.dedupMessages).toBe(true);
    expect(patch.headroomEnabled).toBe(false);
    expect(patch.summaryInject).toBe(false);
    expect(patch.historyTrimMaxBytes).toBeGreaterThan(0);
  });

  it("full enables headroom, ponytail, trim and summary", () => {
    const patch = applySaverMode("full");
    expect(patch.rtkEnabled).toBe(true);
    expect(patch.headroomEnabled).toBe(true);
    expect(patch.ponytailEnabled).toBe(true);
    expect(patch.dedupMessages).toBe(true);
    expect(patch.historyTrimMaxBytes).toBeGreaterThan(0);
    expect(patch.summaryInject).toBe(true);
    expect(patch.cavemanEnabled).toBe(false);
  });

  it("ultra enables everything with aggressive thresholds", () => {
    const patch = applySaverMode("ultra");
    expect(patch.rtkEnabled).toBe(true);
    expect(patch.headroomEnabled).toBe(true);
    expect(patch.cavemanEnabled).toBe(true);
    expect(patch.ponytailEnabled).toBe(true);
    expect(patch.dedupMessages).toBe(true);
    expect(patch.summaryInject).toBe(true);
    expect(patch.headroomCompressUserMessages).toBe(true);
    expect(patch.historyTrimMaxBytes).toBeLessThan(applySaverMode("full").historyTrimMaxBytes);
    expect(patch.summaryInjectAboveBytes).toBeLessThan(applySaverMode("full").summaryInjectAboveBytes);
  });

  it("unknown mode returns empty patch", () => {
    expect(applySaverMode("nope")).toEqual({});
  });
});

describe("detectSaverMode", () => {
  it("matches each preset exactly", () => {
    for (const mode of SAVER_MODES) {
      const settings = { ...MODE_PRESETS[mode] };
      // Extra unrelated keys must not break detection
      settings.someOtherSetting = true;
      expect(detectSaverMode(settings)).toBe(mode);
    }
  });

  it("returns custom when toggles diverge from every preset", () => {
    const settings = { ...MODE_PRESETS.ultra, dedupMessages: false };
    expect(detectSaverMode(settings)).toBe("custom");
  });

  it("defaults (all off) detect as off", () => {
    expect(detectSaverMode({})).toBe("off");
  });
});
