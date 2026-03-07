import { NextRequest, NextResponse } from "next/server";
import { supabaseServerClient } from "@/lib/supabase-server";

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

    // Download file from Supabase
    const { data: fileData, error: downloadError } =
      await supabaseServerClient.storage
        .from("blends")
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
    
    // Convert to base64 for Modal
    const fileBase64 = Buffer.from(fileBytes).toString('base64');
    
    // Call Modal estimation endpoint
    const modalResponse = await fetch("https://ksshalini1--blend-renderer-estimate-render-time.modal.run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        blend_file_base64: fileBase64
      }),
    });

    if (!modalResponse.ok) {
      const errorText = await modalResponse.text();
      console.error("Modal estimation error:", errorText);
      return NextResponse.json(
        { error: "Failed to estimate render time", details: errorText },
        { status: 500 }
      );
    }

    const estimateData = await modalResponse.json();
    
    return NextResponse.json(estimateData);
  } catch (error) {
    console.error("Unexpected error in estimate-render:", error);
    return NextResponse.json(
      { error: "Unexpected server error" },
      { status: 500 },
    );
  }
}
