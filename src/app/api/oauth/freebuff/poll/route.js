import { NextResponse } from "next/server";
import { createProviderConnection } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// GET /api/oauth/freebuff/poll?fingerprintId=...&fingerprintHash=...&expiresAt=...
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const fingerprintId = searchParams.get("fingerprintId");
    const fingerprintHash = searchParams.get("fingerprintHash");
    const expiresAt = searchParams.get("expiresAt");

    if (!fingerprintId || !fingerprintHash) {
      return NextResponse.json({ error: "Missing required query parameters" }, { status: 400 });
    }

    const statusPath = `https://freebuff.com/api/auth/cli/status?fingerprintId=${encodeURIComponent(fingerprintId)}&fingerprintHash=${encodeURIComponent(fingerprintHash)}&expiresAt=${expiresAt || ""}`;

    const res = await fetch(statusPath, {
      method: "GET",
      headers: {
        accept: "*/*",
        "user-agent": "Bun/1.3.11",
      },
    });

    if (res.status === 401) {
      return NextResponse.json({ authenticated: false, message: "Waiting for user to log in..." });
    }

    if (res.status !== 200) {
      return NextResponse.json({ authenticated: false, error: `Auth status check returned ${res.status}` });
    }

    const text = await res.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      return NextResponse.json({ authenticated: false, error: "Invalid JSON response" });
    }

    if (data.user && data.user.authToken) {
      const email = data.user.email || data.user.name || "Freebuff Account";
      const connection = await createProviderConnection({
        provider: "freebuff",
        name: email,
        apiKey: data.user.authToken,
        accessToken: data.user.authToken,
        status: "active",
        providerSpecificData: {
          fingerprintId: data.user.fingerprintId || fingerprintId,
          fingerprintHash: data.user.fingerprintHash || fingerprintHash,
          userId: data.user.id,
          name: data.user.name,
          email: data.user.email,
          createdAt: new Date().toISOString(),
        },
      });

      // Best-effort sync token to local freebuff-proxy
      fetch("http://127.0.0.1:9187/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: data.user.authToken, email, name: data.user.name || email }),
      }).catch(() => null);

      return NextResponse.json({
        authenticated: true,
        user: data.user,
        connection,
      });
    }

    return NextResponse.json({ authenticated: false, message: "Waiting for user authentication..." });
  } catch (err) {
    console.error("Freebuff auth poll error:", err);
    return NextResponse.json({ authenticated: false, error: err.message }, { status: 500 });
  }
}
