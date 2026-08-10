import { NextResponse } from "next/server";
import { getHeadroomLogTail } from "@/lib/headroom/process";

export const dynamic = "force-dynamic";

// GET /api/headroom/log — tail of the managed proxy log for diagnosis in the UI.
export async function GET(request) {
  const url = new URL(request.url);
  const maxLines = Math.min(500, Math.max(10, parseInt(url.searchParams.get("lines") || "200", 10) || 200));
  try {
    return NextResponse.json({ log: getHeadroomLogTail(maxLines) });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}