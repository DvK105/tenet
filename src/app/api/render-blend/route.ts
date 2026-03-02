import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { supabaseServerClient } from "@/lib/supabase-server";

const modalRenderEndpoint = process.env.MODAL_RENDER_ENDPOINT;

if (!modalRenderEndpoint) {
  throw new Error("MODAL_RENDER_ENDPOINT must be set");
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const key: string | undefined = body?.key;

    if (!key) {
      return NextResponse.json(
        { error: "Missing key in request body" },
        { status: 400 },
      );
    }

    const blendsBucket =
      process.env.SUPABASE_BLENDS_BUCKET ?? "blends";
    const rendersBucket =
      process.env.SUPABASE_RENDERS_BUCKET ?? "renders";

    const { data: signed, error: signedError } =
      await supabaseServerClient.storage
        .from(blendsBucket)
        .createSignedUrl(key, 60 * 60); // 1 hour

    if (signedError || !signed?.signedUrl) {
      console.error("Supabase signed URL error:", signedError);
      return NextResponse.json(
        { error: "Failed to create signed URL" },
        { status: 500 },
      );
    }

    const outputKey = `renders/${randomUUID()}.mp4`;

    const modalResponse = await fetch(modalRenderEndpoint!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        blend_url: signed.signedUrl,
        output_key: outputKey,
        renders_bucket: rendersBucket,
      }),
    });

    if (!modalResponse.ok) {
      const text = await modalResponse.text();
      console.error("Modal render error:", modalResponse.status, text);
      return NextResponse.json(
        { error: "Modal render failed" },
        { status: 502 },
      );
    }

    const data = await modalResponse.json();

    return NextResponse.json({
      imageUrl: data.image_url ?? data.imageUrl,
      outputKey,
    });
  } catch (error) {
    console.error("Unexpected error in render-blend:", error);
    return NextResponse.json(
      { error: "Unexpected server error" },
      { status: 500 },
    );
  }
}

