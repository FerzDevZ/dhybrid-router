import { NextResponse } from "next/server";
import { getTokenSaverStats } from "@/lib/tokenSaver/events.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const timelineDays = Math.min(Number(searchParams.get("timelineDays")) || 30, 90);
    const recentLimit = Math.min(Number(searchParams.get("recentLimit")) || 100, 500);
    return NextResponse.json(getTokenSaverStats({ timelineDays, recentLimit }));
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}