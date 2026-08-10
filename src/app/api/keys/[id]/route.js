import { NextResponse } from "next/server";
import { deleteApiKey, getApiKeyById, updateApiKey } from "@/lib/localDb";
import { maskKey } from "@/lib/maskKey";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";

// GET /api/keys/[id] - Get single key (masked by default; full key only with
// `?reveal=true` AND a valid dashboard JWT — requireLogin=false is NOT enough,
// so remote configs cannot exfiltrate keys verbatim).
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const key = await getApiKeyById(id);
    if (!key) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }
    const url = new URL(request.url);
    const reveal = url.searchParams.get("reveal") === "true";
    if (reveal) {
      const token = request.cookies.get("auth_token")?.value;
      if (!(await verifyDashboardAuthToken(token))) {
        return NextResponse.json({ key: { ...key, key: maskKey(key.key) } });
      }
      return NextResponse.json({ key });
    }
    return NextResponse.json({ key: { ...key, key: maskKey(key.key) } });
  } catch (error) {
    console.log("Error fetching key:", error);
    return NextResponse.json({ error: "Failed to fetch key" }, { status: 500 });
  }
}

// PUT /api/keys/[id] - Update key
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { isActive } = body;

    const existing = await getApiKeyById(id);
    if (!existing) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    const updateData = {};
    if (isActive !== undefined) updateData.isActive = isActive;

    const updated = await updateApiKey(id, updateData);

    return NextResponse.json({ key: updated });
  } catch (error) {
    console.log("Error updating key:", error);
    return NextResponse.json({ error: "Failed to update key" }, { status: 500 });
  }
}

// DELETE /api/keys/[id] - Delete API key
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;

    const deleted = await deleteApiKey(id);
    if (!deleted) {
      return NextResponse.json({ error: "Key not found" }, { status: 404 });
    }

    return NextResponse.json({ message: "Key deleted successfully" });
  } catch (error) {
    console.log("Error deleting key:", error);
    return NextResponse.json({ error: "Failed to delete key" }, { status: 500 });
  }
}
