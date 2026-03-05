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

    // Download the file from Supabase instead of creating a signed URL
    const { data: fileData, error: downloadError } =
      await supabaseServerClient.storage
        .from(blendsBucket)
        .download(key);

    if (downloadError || !fileData) {
      console.error("Supabase download error:", downloadError);
      return NextResponse.json(
        { error: "Failed to download file from storage" },
        { status: 500 },
      );
    }

    // Convert file to bytes
    const fileBytes = new Uint8Array(await fileData.arrayBuffer());
    
    const outputKey = `renders/${randomUUID()}.mp4`;

    // Call Modal with file bytes directly (like the official example)
    const modalUrl = process.env.MODAL_RENDER_ENDPOINT!;
    
    const modalResponse = await fetch(modalUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        blend_file_bytes: Array.from(fileBytes), // Convert to regular array for JSON serialization
        output_key: outputKey
      }),
    });

    if (!modalResponse.ok) {
      const text = await modalResponse.text();
      console.error("Modal render error:", modalResponse.status, text);
      return NextResponse.json(
        {
          error: "Modal render failed",
          modalStatus: modalResponse.status,
          modalBody: text,
        },
        { status: 502 },
      );
    }

    const data = await modalResponse.text();
    
    // Modal returns the URL as a plain string, not JSON
    if (data.startsWith('ERROR:')) {
      const errorMessage = data.substring(6); // Remove 'ERROR:' prefix
      console.error("Modal render error:", errorMessage);
      return NextResponse.json(
        { error: "Modal render failed", modalError: errorMessage },
        { status: 502 }
      );
    }

    return NextResponse.json({
      imageUrl: data, // The video URL string
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

