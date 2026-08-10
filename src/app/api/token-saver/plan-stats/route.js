import { NextResponse } from "next/server";
import { getPlanStats } from "@/lib/tokenSaver/events.js";

export const dynamic = "force-dynamic";

// GET /api/token-saver/plan-stats — plan efficiency + budget decisions
export async function GET() {
  try {
    return NextResponse.json(getPlanStats());
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
