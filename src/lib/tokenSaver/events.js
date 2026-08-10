import fs from "fs";
import path from "path";
import { PXPIPE_DIR } from "@/lib/pxpipe/install.js";

const TOKEN_SAVER_DIR = path.join(PXPIPE_DIR, "..", "token-saver");
const EVENTS_FILE = path.join(TOKEN_SAVER_DIR, "events.jsonl");
const ROTATED_FILE = path.join(TOKEN_SAVER_DIR, "events.jsonl.1");
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

function ensureDir() {
  if (!fs.existsSync(TOKEN_SAVER_DIR)) fs.mkdirSync(TOKEN_SAVER_DIR, { recursive: true });
}

// Fire-and-forget: stats must never break the request path.
export function appendTokenSaverEvent(event) {
  try {
    ensureDir();
    try {
      const stat = fs.statSync(EVENTS_FILE);
      if (stat.size > MAX_FILE_BYTES) fs.renameSync(EVENTS_FILE, ROTATED_FILE);
    } catch { /* no file yet */ }
    fs.appendFile(EVENTS_FILE, JSON.stringify({ ts: Date.now(), ...event }) + "\n", () => {});
  } catch { /* ignore */ }
}

export function readTokenSaverEvents({ sinceMs = null, limit = null } = {}) {
  const events = [];
  for (const file of [ROTATED_FILE, EVENTS_FILE]) {
    try {
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (sinceMs && ev.ts < sinceMs) continue;
          events.push(ev);
        } catch { /* skip corrupt line */ }
      }
    } catch { /* ignore */ }
  }
  events.sort((a, b) => a.ts - b.ts);
  return limit ? events.slice(-limit) : events;
}

function emptyTotals() {
  return {
    requests: 0,
    rtk: { requests: 0, compressed: 0, tokensBefore: 0, tokensAfter: 0, tokensSaved: 0, savedPct: 0 },
    headroom: { requests: 0, compressed: 0, tokensBefore: 0, tokensAfter: 0, tokensSaved: 0, savedPct: 0, errors: 0, bypassed: 0 },
    pxpipe: { requests: 0, compressed: 0, tokensBeforeEst: 0, tokensAfterEst: 0, tokensSavedEst: 0, savedPct: 0, imagesGenerated: 0, compressionTimeMs: 0, avgCompressionMs: 0 },
    caveman: { requests: 0, applied: 0 },
    ponytail: { requests: 0, applied: 0 },
  };
}

function accumulateRtk(totals, ev) {
  if (!ev.rtk) return;
  totals.rtk.requests++;
  if (ev.rtk.hits && ev.rtk.hits.length > 0) {
    totals.rtk.compressed++;
    totals.rtk.tokensBefore += ev.rtk.bytesBefore || 0;
    totals.rtk.tokensAfter += ev.rtk.bytesAfter || 0;
    totals.rtk.tokensSaved += (ev.rtk.bytesBefore || 0) - (ev.rtk.bytesAfter || 0);
  }
}

function accumulateHeadroom(totals, ev) {
  if (!ev.headroom) return;
  totals.headroom.requests++;
  if (ev.headroom.tokens_saved !== undefined) {
    if (ev.headroom.tokens_saved > 0) {
      totals.headroom.compressed++;
      totals.headroom.tokensBefore += ev.headroom.tokens_before || 0;
      totals.headroom.tokensAfter += ev.headroom.tokens_after || 0;
      totals.headroom.tokensSaved += ev.headroom.tokens_saved || 0;
    } else if (ev.headroom.tokens_before !== undefined && ev.headroom.tokens_after !== undefined) {
      totals.headroom.bypassed++;
    }
  } else if (ev.headroom.reason) {
    totals.headroom.errors++;
  }
}

function accumulatePxpipe(totals, ev) {
  if (!ev.pxpipe) return;
  totals.pxpipe.requests++;
  if (ev.pxpipe.applied) {
    totals.pxpipe.compressed++;
    totals.pxpipe.tokensBeforeEst += ev.pxpipe.tokensBeforeEst || 0;
    totals.pxpipe.tokensAfterEst += ev.pxpipe.tokensAfterEst || 0;
    totals.pxpipe.tokensSavedEst += ev.pxpipe.tokensSavedEst || 0;
    totals.pxpipe.imagesGenerated += ev.pxpipe.imageCount || 0;
    totals.pxpipe.compressionTimeMs += ev.pxpipe.durationMs || 0;
  } else if (ev.pxpipe.reason === "transform_error" || ev.pxpipe.reason === "timeout") {
    // errors counted elsewhere
  } else {
    totals.pxpipe.bypassed++;
  }
}

function accumulateCaveman(totals, ev) {
  if (!ev.caveman) return;
  totals.caveman.requests++;
  if (ev.caveman.applied) totals.caveman.applied++;
}

function accumulatePonytail(totals, ev) {
  if (!ev.ponytail) return;
  totals.ponytail.requests++;
  if (ev.ponytail.applied) totals.ponytail.applied++;
}

function finalize(totals) {
  if (totals.rtk.tokensBefore > 0) {
    totals.rtk.savedPct = +((totals.rtk.tokensSaved / totals.rtk.tokensBefore) * 100).toFixed(2);
  }
  if (totals.headroom.tokensBefore > 0) {
    totals.headroom.savedPct = +((totals.headroom.tokensSaved / totals.headroom.tokensBefore) * 100).toFixed(2);
  }
  if (totals.pxpipe.tokensBeforeEst > 0) {
    totals.pxpipe.savedPct = +((totals.pxpipe.tokensSavedEst / totals.pxpipe.tokensBeforeEst) * 100).toFixed(2);
  }
  totals.pxpipe.avgCompressionMs = totals.pxpipe.compressed > 0
    ? Math.round(totals.pxpipe.compressionTimeMs / totals.pxpipe.compressed)
    : 0;
  return totals;
}

// Aggregated stats for the dashboard: all-time + windowed totals, a daily
// tokens-saved timeline (last `timelineDays`), per-model/per-provider
// breakdown, and the most recent events.
export function getTokenSaverStats({ timelineDays = 30, recentLimit = 100 } = {}) {
  const events = readTokenSaverEvents();
  const now = Date.now();
  // UTC midnight (consistent with the ISO date keys used for the timeline)
  const d = new Date(now);
  const startOfToday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

  const windows = {
    all: emptyTotals(),
    today: emptyTotals(),
    yesterday: emptyTotals(),
    last7d: emptyTotals(),
    last30d: emptyTotals(),
  };

  // Per-model and per-provider aggregates (sorted desc by combined tokens saved)
  const byModel = new Map();      // key: model  → { requests, tokensSaved (all savers), rtk, headroom, pxpipe, img }
  const byProvider = new Map();   // key: provider → same shape + models Set

  const bumpRow = (row, ev) => {
    row.requests++;
    row.rtk += (ev.rtk && ev.rtk.hits?.length > 0) ? Math.max(0, (ev.rtk.bytesBefore || 0) - (ev.rtk.bytesAfter || 0)) : 0;
    row.headroom += ev.headroom?.tokens_saved > 0 ? ev.headroom.tokens_saved : 0;
    row.pxpipe += ev.pxpipe?.applied ? (ev.pxpipe.tokensSavedEst || 0) : 0;
    row.imgs += ev.pxpipe?.applied ? (ev.pxpipe.imageCount || 0) : 0;
    row.tokensSaved = row.rtk + row.headroom + row.pxpipe;
  };
  const rowFor = (m, k) => {
    if (!m.has(k)) m.set(k, { requests: 0, tokensSaved: 0, rtk: 0, headroom: 0, pxpipe: 0, imgs: 0, models: new Set() });
    return m.get(k);
  };

  const timeline = new Map();
  for (let i = timelineDays - 1; i >= 0; i--) {
    const day = new Date(startOfToday - i * DAY_MS);
    timeline.set(day.toISOString().slice(0, 10), {
      date: day.toISOString().slice(0, 10),
      requests: 0,
      rtk: { tokensSaved: 0, compressed: 0, requests: 0 },
      headroom: { tokensSaved: 0, compressed: 0, requests: 0 },
      pxpipe: { tokensSavedEst: 0, compressed: 0, requests: 0 },
      caveman: { applied: 0, requests: 0 },
      ponytail: { applied: 0, requests: 0 },
    });
  }

  for (const ev of events) {
    accumulateRtk(windows.all, ev);
    accumulateHeadroom(windows.all, ev);
    accumulatePxpipe(windows.all, ev);
    accumulateCaveman(windows.all, ev);
    accumulatePonytail(windows.all, ev);
    windows.all.requests++;

    if (ev.ts >= startOfToday) {
      accumulateRtk(windows.today, ev);
      accumulateHeadroom(windows.today, ev);
      accumulatePxpipe(windows.today, ev);
      accumulateCaveman(windows.today, ev);
      accumulatePonytail(windows.today, ev);
      windows.today.requests++;
    } else if (ev.ts >= startOfToday - DAY_MS) {
      accumulateRtk(windows.yesterday, ev);
      accumulateHeadroom(windows.yesterday, ev);
      accumulatePxpipe(windows.yesterday, ev);
      accumulateCaveman(windows.yesterday, ev);
      accumulatePonytail(windows.yesterday, ev);
      windows.yesterday.requests++;
    }
    if (ev.ts >= now - 7 * DAY_MS) {
      accumulateRtk(windows.last7d, ev);
      accumulateHeadroom(windows.last7d, ev);
      accumulatePxpipe(windows.last7d, ev);
      accumulateCaveman(windows.last7d, ev);
      accumulatePonytail(windows.last7d, ev);
      windows.last7d.requests++;
    }
    if (ev.ts >= now - 30 * DAY_MS) {
      accumulateRtk(windows.last30d, ev);
      accumulateHeadroom(windows.last30d, ev);
      accumulatePxpipe(windows.last30d, ev);
      accumulateCaveman(windows.last30d, ev);
      accumulatePonytail(windows.last30d, ev);
      windows.last30d.requests++;
    }

    // per-model / per-provider row
    const modelKey = ev.model || "(unknown)";
    const provKey = ev.provider || "(unknown)";
    bumpRow(rowFor(byModel, modelKey), ev);
    const provRow = rowFor(byProvider, provKey);
    bumpRow(provRow, ev);
    provRow.models.add(modelKey);

    const key = new Date(ev.ts).toISOString().slice(0, 10);
    const bucket = timeline.get(key);
    if (bucket) {
      bucket.requests++;
      if (ev.rtk && ev.rtk.hits && ev.rtk.hits.length > 0) {
        bucket.rtk.compressed++;
        bucket.rtk.tokensSaved += (ev.rtk.bytesBefore || 0) - (ev.rtk.bytesAfter || 0);
      }
      if (ev.headroom && ev.headroom.tokens_saved > 0) {
        bucket.headroom.compressed++;
        bucket.headroom.tokensSaved += ev.headroom.tokens_saved || 0;
      }
      if (ev.pxpipe && ev.pxpipe.applied) {
        bucket.pxpipe.compressed++;
        bucket.pxpipe.tokensSavedEst += ev.pxpipe.tokensSavedEst || 0;
      }
      if (ev.caveman && ev.caveman.applied) bucket.caveman.applied++;
      if (ev.ponytail && ev.ponytail.applied) bucket.ponytail.applied++;
    }
  }

  for (const w of Object.values(windows)) finalize(w);

  const toSortedList = (m) => [...m.entries()]
    .map(([name, r]) => ({ name, requests: r.requests, tokensSaved: r.tokensSaved, rtk: r.rtk, headroom: r.headroom, pxpipe: r.pxpipe, img: r.imgs, models: r.models ? [...r.models].sort() : undefined }))
    .sort((a, b) => b.tokensSaved - a.tokensSaved);

  // Per-plan breakdown (custom plans only) for dashboard insight
  const byPlan = new Map();
  for (const ev of events) {
    if (!ev.planId || ev.planId === "none" || ev.planReason === "default") continue;
    const row = byPlan.get(ev.planId) || { planId: ev.planId, requests: 0, tokensSaved: 0 };
    row.requests++;
    row.tokensSaved +=
      (ev.rtk && ev.rtk.hits ? (ev.rtk.bytesBefore || 0) - (ev.rtk.bytesAfter || 0) : 0) +
      (ev.headroom?.tokens_saved > 0 ? ev.headroom.tokens_saved : 0) +
      (ev.pxpipe?.applied ? ev.pxpipe.tokensSavedEst || 0 : 0);
    byPlan.set(ev.planId, row);
  }

  return {
    windows,
    byModel: toSortedList(byModel),
    byProvider: toSortedList(byProvider),
    byPlan: [...byPlan.values()].sort((a, b) => b.tokensSaved - a.tokensSaved),
    timeline: [...timeline.values()],
    recent: events.slice(-recentLimit).reverse(),
  };
}

// Lightweight plan-efficiency stats for the dashboard widget (no timeline).
export function getPlanStats() {
  const events = readTokenSaverEvents({ limit: 500 });
  const byPlan = new Map();
  const byBudgetDecision = { permit: 0, warn: 0, degrade: 0, block: 0 };
  for (const ev of events) {
    if (ev.budgetDecision) byBudgetDecision[ev.budgetDecision] = (byBudgetDecision[ev.budgetDecision] || 0) + 1;
    if (!ev.planId || ev.planId === "none") continue;
    const row = byPlan.get(ev.planId) || { planId: ev.planId, requests: 0, tokensSaved: 0 };
    row.requests++;
    row.tokensSaved +=
      (ev.rtk && ev.rtk.hits ? (ev.rtk.bytesBefore || 0) - (ev.rtk.bytesAfter || 0) : 0) +
      (ev.headroom?.tokens_saved > 0 ? ev.headroom.tokens_saved : 0) +
      (ev.pxpipe?.applied ? ev.pxpipe.tokensSavedEst || 0 : 0);
    byPlan.set(ev.planId, row);
  }
  return {
    byPlan: [...byPlan.values()].sort((a, b) => b.tokensSaved - a.tokensSaved),
    byBudgetDecision,
  };
}