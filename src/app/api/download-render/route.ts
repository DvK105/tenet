import { NextRequest, NextResponse } from "next/server";

const SUPABASE_STORAGE_HOST = "supabase.co";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const url = typeof body?.url === "string" ? body.url.trim() : null;

    if (!url) {
      return NextResponse.json(
        { error: "Missing url in request body" },
        { status: 400 }
      );
    }

    // Only allow Supabase storage URLs to prevent SSRF
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
    }
    if (!parsed.hostname.includes(SUPABASE_STORAGE_HOST)) {
      return NextResponse.json(
        { error: "URL must be from Supabase storage" },
        { status: 400 }
      );
    }

    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "video/mp4" },
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: "Failed to fetch video" },
        { status: 502 }
      );
    }

    const blob = await res.blob();
    return new NextResponse(blob, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": 'attachment; filename="rendered-video.mp4"',
      },
    });
  } catch (err) {
    console.error("Error in /api/download-render:", err);
    return NextResponse.json(
      { error: "Failed to download video" },
      { status: 500 }
    );
  }
}
