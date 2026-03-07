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

    // Call Modal with async submit-render endpoint
    const modalSubmitUrl = "https://ksshalini1--blend-renderer-submit-render-http.modal.run";
    
    // Convert file to base64 for submission
    const fileBase64 = Buffer.from(fileBytes).toString('base64');
    
    const submitFormData = new FormData();
    submitFormData.append('blend_file_base64', fileBase64);
    submitFormData.append('output_key', outputKey);
    
    // Submit async render job
    const submitResponse = await fetch(modalSubmitUrl, {
      method: "POST",
      body: submitFormData
    });
    
    if (!submitResponse.ok) {
      const errorText = await submitResponse.text();
      console.error("Modal submit error:", errorText);
      return NextResponse.json(
        { error: "Failed to submit render job", details: errorText },
        { status: 500 }
      );
    }
    
    const submitData = await submitResponse.json();
    const callId = submitData.call_id;
    
    if (!callId) {
      return NextResponse.json(
        { error: "Modal submit did not return call_id" },
        { status: 502 }
      );
    }
    
    // Poll for result
    const resultUrl = `https://ksshalini1--blend-renderer-render-result-http.modal.run?call_id=${callId}`;
    
    return NextResponse.json({
      callId,
      resultUrl,
      outputKey,
      status: "submitted"
    });
  } catch (error) {
    console.error("Unexpected error in render-blend:", error);
    return NextResponse.json(
      { error: "Unexpected server error" },
      { status: 500 },
    );
  }
}

