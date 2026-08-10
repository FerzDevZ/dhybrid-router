import { NextResponse } from "next/server";
import { getSettings } from "@/lib/localDb";

export const dynamic = "force-dynamic";

export async function GET() {
  const startTime = process.uptime();
  const version = process.env.npm_package_version || "unknown";
  
  try {
    // Quick DB connectivity check
    const settings = await getSettings();
    const dbConnected = !!settings;
    
    return NextResponse.json({
      status: "ok",
      uptime: startTime,
      version,
      dbConnected,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({
      status: "degraded",
      uptime: startTime,
      version,
      dbConnected: false,
      error: error?.message || "Unknown error",
      timestamp: new Date().toISOString(),
    }, { status: 503 });
  }
}