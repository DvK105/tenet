import { NextRequest, NextResponse } from "next/server";
import { supabaseServerClient } from "@/lib/supabase-server";

const MODAL_RESULT_URL =
  process.env.MODAL_RENDER_RESULT_URL ??
  "https://ksshalini1--blend-renderer-render-result-http.modal.run";
const RENDERS_BUCKET = process.env.SUPABASE_RENDERS_BUCKET ?? "renders";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const callId = searchParams.get("callId");

    if (!callId) {
      return NextResponse.json({ error: "Missing callId" }, { status: 400 });
    }

    const statusUrl = `${MODAL_RESULT_URL}?call_id=${encodeURIComponent(callId)}`;
    const res = await fetch(statusUrl, {
      method: "GET",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    const text = await res.text();

    let data: {
      status?: string;
      url?: string;
      error?: string;
      render_time_seconds?: number;
    };
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      return NextResponse.json(
        {
          error: "Failed to fetch render status",
          details: res.ok ? text : `Modal returned ${res.status}: ${text.slice(0, 500)}`,
        },
        { status: 502 }
      );
    }

    if (!res.ok) {
      return NextResponse.json(
        {
          status: data.status ?? "error",
          error: data.error ?? "Failed to fetch render status",
          details: text.slice(0, 500),
        },
        { status: 502 }
      );
    }

    let progress: {
      elapsed_seconds?: number;
      frames_done?: number;
      total_frames?: number;
      eta_seconds?: number;
      stuck?: boolean;
      blender_eta?: string;
      avg_frame_time?: number;
      total_polls?: number;
    } | null = null;
    if (data.status === "running") {
      try {
        const { data: progressData } = await supabaseServerClient.storage
          .from(RENDERS_BUCKET)
          .download(`progress/${callId}.json`);
        if (progressData) {
          const json = JSON.parse(await progressData.text()) as typeof progress;
          progress = json;
        }
      } catch {
        // Progress file may not exist yet
      }
    }

    return NextResponse.json({
      status: data.status,
      url: data.url,
      error: data.error,
      render_time_seconds: data.render_time_seconds,
      progress: progress ?? undefined,
    });
  } catch (err) {
    console.error("Error in /api/render-status:", err);
    return NextResponse.json({ error: "Unexpected server error" }, { status: 500 });
  }
}
