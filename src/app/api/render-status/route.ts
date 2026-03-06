import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const callId = searchParams.get("callId");

    if (!callId) {
      return NextResponse.json({ error: "Missing callId" }, { status: 400 });
    }

    const statusUrl = `https://dvk105--blend-renderer-render-result-http.modal.run?call_id=${encodeURIComponent(callId)}`;

    const res = await fetch(statusUrl, { method: "GET" });
    const text = await res.text();

    if (!res.ok) {
      return NextResponse.json(
        { error: "Failed to fetch render status", details: text },
        { status: 502 },
      );
    }

    // Modal endpoint returns JSON; be defensive.
    const data = JSON.parse(text) as { status?: string; url?: string; error?: string };
    return NextResponse.json(data);
  } catch (err) {
    console.error("Error in /api/render-status:", err);
    return NextResponse.json({ error: "Unexpected server error" }, { status: 500 });
  }
}
