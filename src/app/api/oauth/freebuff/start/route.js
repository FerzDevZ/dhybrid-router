import { NextResponse } from "next/server";
import crypto from "crypto";

export const dynamic = "force-dynamic";

/**
 * Generate synthetic fingerprint (matching fatmuh/freebuff-proxy synthetic-fingerprint)
 */
function generateSyntheticFingerprint() {
  const hex = crypto.randomBytes(16).toString("hex");
  const fingerprintId = `enhanced-s-${hex}`;
  const fingerprintHash = crypto.createHash("sha256").update(fingerprintId).digest("hex");
  return { fingerprintId, fingerprintHash };
}

// POST /api/oauth/freebuff/start - Start Freebuff Web Auth Flow
export async function POST() {
  try {
    const { fingerprintId } = generateSyntheticFingerprint();

    const res = await fetch("https://freebuff.com/api/auth/cli/code", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "*/*",
        "user-agent": "Bun/1.3.11",
      },
      body: JSON.stringify({ fingerprintId }),
    });

    const text = await res.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch (e) {
      return NextResponse.json({ error: "Invalid response from Freebuff auth server" }, { status: 502 });
    }

    if (res.status !== 200 || !data.loginUrl) {
      return NextResponse.json({ error: data.message || "Failed to start Freebuff login flow" }, { status: res.status });
    }

    return NextResponse.json({
      success: true,
      loginUrl: data.loginUrl,
      fingerprintId,
      fingerprintHash: data.fingerprintHash,
      expiresAt: data.expiresAt,
    });
  } catch (err) {
    console.error("Freebuff auth start error:", err);
    return NextResponse.json({ error: err.message || "Internal server error" }, { status: 500 });
  }
}
