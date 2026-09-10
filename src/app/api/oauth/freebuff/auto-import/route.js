import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";
import { createProviderConnection } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// Candidate paths for Freebuff / Codebuff credentials
const CANDIDATE_PATHS = [
  path.join(os.homedir(), ".config", "manicode", "credentials.json"),
  path.join(os.homedir(), ".codebuff", "credentials.json"),
  path.join(os.homedir(), ".freebuff", "credentials.json"),
  path.join(os.homedir(), ".config", "codebuff", "credentials.json"),
];

// POST /api/oauth/freebuff/auto-import
export async function POST() {
  try {
    let foundPath = null;
    let rawContent = null;

    for (const p of CANDIDATE_PATHS) {
      if (fs.existsSync(p)) {
        foundPath = p;
        rawContent = fs.readFileSync(p, "utf-8");
        break;
      }
    }

    if (!foundPath || !rawContent) {
      return NextResponse.json({
        success: false,
        error: "No local Freebuff/Codebuff credentials file found in ~/.config/manicode/ or ~/.codebuff/",
      }, { status: 404 });
    }

    let parsed = {};
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON in credentials file" }, { status: 400 });
    }

    const targetObj = parsed.default || (parsed[Object.keys(parsed)[0]] && typeof parsed[Object.keys(parsed)[0]] === "object" ? parsed[Object.keys(parsed)[0]] : parsed);
    const token =
      targetObj.authToken ||
      targetObj.token ||
      targetObj.accessToken ||
      targetObj.access_token ||
      targetObj.apiKey ||
      targetObj.sessionToken ||
      targetObj.session ||
      targetObj.jwt ||
      targetObj.auth?.token ||
      targetObj.session?.token ||
      targetObj.user?.token ||
      "freebuff-session-token";

    const email = targetObj.email || targetObj.name || targetObj.username || targetObj.userId || "freebuff-local-user";

    const connection = await createProviderConnection({
      provider: "freebuff",
      name: email,
      apiKey: token,
      accessToken: token,
      status: "active",
      providerSpecificData: {
        sourcePath: foundPath,
        importedAt: new Date().toISOString(),
      },
    });

    // Best-effort sync token to local freebuff-proxy
    fetch("http://127.0.0.1:9187/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, email, name: email }),
    }).catch(() => null);

    return NextResponse.json({
      success: true,
      message: `Successfully imported Freebuff credentials for ${email}`,
      connection,
    });
  } catch (err) {
    console.error("Freebuff auto-import error:", err);
    return NextResponse.json({ success: false, error: err.message || "Failed to auto-import Freebuff credentials" }, { status: 500 });
  }
}
