import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";
import { getProviderConnections, updateProviderConnection, createProviderConnection } from "@/lib/db/repos/connectionsRepo";

export const dynamic = "force-dynamic";

const CANDIDATE_PATHS = [
  path.join(os.homedir(), ".config", "manicode", "credentials.json"),
  path.join(os.homedir(), ".codebuff", "credentials.json"),
  path.join(os.homedir(), ".freebuff", "credentials.json"),
  path.join(os.homedir(), ".config", "codebuff", "credentials.json"),
];

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
        error: "No local Freebuff credentials file found in ~/.config/manicode/ or ~/.codebuff/",
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
      targetObj.apiKey;

    if (!token) {
      return NextResponse.json({ success: false, error: "No valid auth token found in credentials file" }, { status: 400 });
    }

    const email = targetObj.email || targetObj.name || "hitamkanrakyat2@gmail.com";
    const name = targetObj.name || email;

    const existingConns = await getProviderConnections({ provider: "freebuff" });
    const connForEmail = (existingConns || []).find((c) => {
      const connEmail = c.email || c.name || c.providerSpecificData?.email;
      return connEmail && connEmail.toLowerCase() === email.toLowerCase();
    });

    if (connForEmail) {
      let dataObj = {};
      try { dataObj = typeof connForEmail.data === "string" ? JSON.parse(connForEmail.data) : (connForEmail.data || {}); } catch {}
      dataObj.accessToken = token;
      dataObj.apiKey = token;
      dataObj.testStatus = "active";
      dataObj.lastError = null;
      dataObj.errorCode = null;
      dataObj.providerSpecificData = {
        ...(dataObj.providerSpecificData || {}),
        fingerprintId: targetObj.fingerprintId,
        fingerprintHash: targetObj.fingerprintHash,
        userId: targetObj.id,
        name,
        email,
        syncedAt: new Date().toISOString(),
      };

      await updateProviderConnection(connForEmail.id, {
        apiKey: token,
        accessToken: token,
        name: email,
        data: JSON.stringify(dataObj),
        status: "active",
      });
    } else {
      await createProviderConnection({
        provider: "freebuff",
        name: email,
        apiKey: token,
        accessToken: token,
        status: "active",
        providerSpecificData: {
          fingerprintId: targetObj.fingerprintId,
          fingerprintHash: targetObj.fingerprintHash,
          userId: targetObj.id,
          name,
          email,
          syncedAt: new Date().toISOString(),
        },
      });
    }

    // Sync to proxy engine
    fetch("http://127.0.0.1:9187/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, email, name }),
    }).catch(() => null);

    return NextResponse.json({
      success: true,
      message: `Successfully synced fresh Freebuff token for ${email}`,
      token: token.slice(0, 8) + "...",
      sourcePath: foundPath,
    });
  } catch (err) {
    console.error("Freebuff auto-sync error:", err);
    return NextResponse.json({ success: false, error: err.message || "Failed to auto-sync credentials" }, { status: 500 });
  }
}
