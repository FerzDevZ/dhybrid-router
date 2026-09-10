import { NextResponse } from "next/server";
import { updateSettings } from "@/lib/db/repos/settingsRepo.js";
import { setModelAliases } from "@/lib/db/repos/aliasRepo.js";
import { upsertCombo } from "@/lib/db/repos/combosRepo.js";
import { upsertProviderNode } from "@/lib/db/repos/nodesRepo.js";
import { upsertProviderConnection } from "@/lib/db/repos/connectionsRepo.js";
import { upsertProxyPool } from "@/lib/db/repos/proxyPoolsRepo.js";

export async function POST(req) {
  try {
    const payload = await req.json();
    if (!payload || typeof payload !== "object") {
      return NextResponse.json({ error: "Invalid backup JSON payload" }, { status: 400 });
    }

    const counts = {
      settingsUpdated: false,
      aliasesUpdated: false,
      combosImported: 0,
      nodesImported: 0,
      connectionsImported: 0,
      proxyPoolsImported: 0,
    };

    if (payload.settings && typeof payload.settings === "object") {
      await updateSettings(payload.settings);
      counts.settingsUpdated = true;
    }

    if (payload.modelAliases && typeof payload.modelAliases === "object") {
      await setModelAliases(payload.modelAliases);
      counts.aliasesUpdated = true;
    }

    if (Array.isArray(payload.combos)) {
      const validCombos = payload.combos.filter((c) => c && c.id && c.name);
      await Promise.all(validCombos.map((c) => upsertCombo(c)));
      counts.combosImported = validCombos.length;
    }

    if (Array.isArray(payload.providerNodes)) {
      const validNodes = payload.providerNodes.filter((n) => n && n.id && n.provider);
      await Promise.all(validNodes.map((n) => upsertProviderNode(n)));
      counts.nodesImported = validNodes.length;
    }

    if (Array.isArray(payload.providerConnections)) {
      const validConns = payload.providerConnections.filter((c) => c && c.id && c.provider);
      await Promise.all(validConns.map((c) => upsertProviderConnection(c)));
      counts.connectionsImported = validConns.length;
    }

    if (Array.isArray(payload.proxyPools)) {
      const validPools = payload.proxyPools.filter((p) => p && p.id);
      await Promise.all(validPools.map((p) => upsertProxyPool(p)));
      counts.proxyPoolsImported = validPools.length;
    }

    return NextResponse.json({ success: true, counts });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
