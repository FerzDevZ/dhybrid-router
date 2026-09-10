import { NextResponse } from "next/server";
import { getProviderConnections } from "@/lib/db/repos/connectionsRepo";

export async function GET() {
  try {
    const connections = await getProviderConnections({ provider: "freebuff" });
    const formatted = (connections || []).map((c) => ({
      ...c,
      email: c.email || c.displayName || c.name || c.providerSpecificData?.email || c.providerSpecificData?.name,
    }));
    return NextResponse.json({
      id: "freebuff",
      name: "Freebuff / Codebuff",
      connections: formatted,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
