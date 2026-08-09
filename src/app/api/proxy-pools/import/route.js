import { NextResponse } from "next/server";
import { createProxyPool, getProxyPools } from "@/models";
import { normalizeProxyPoolInput } from "../route.js";

// POST /api/proxy-pools/import - Bulk import pools from JSON array
export async function POST(request) {
  try {
    const body = await request.json();
    const pools = Array.isArray(body?.pools) ? body.pools : null;
    if (!pools) {
      return NextResponse.json({ error: "Expected { pools: [...] }" }, { status: 400 });
    }

    const existing = await getProxyPools();
    const existingUrls = new Set(
      existing.map((p) => (p.proxyUrl || "").trim()).filter(Boolean)
    );

    let created = 0;
    let skipped = 0;
    const errors = [];

    for (const entry of pools) {
      const normalized = normalizeProxyPoolInput(entry);
      if (normalized.error) {
        errors.push({ name: entry?.name || "(unnamed)", error: normalized.error });
        continue;
      }
      const urlKey = normalized.proxyUrl.trim();
      if (existingUrls.has(urlKey)) {
        skipped += 1;
        continue;
      }
      try {
        await createProxyPool(normalized);
        existingUrls.add(urlKey);
        created += 1;
      } catch (e) {
        errors.push({ name: normalized.name, error: e?.message || String(e) });
      }
    }

    return NextResponse.json({ created, skipped, failed: errors.length, errors });
  } catch (error) {
    console.log("Error importing proxy pools:", error);
    return NextResponse.json({ error: "Failed to import proxy pools" }, { status: 500 });
  }
}
