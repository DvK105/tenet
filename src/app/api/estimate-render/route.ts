import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const blendFileBase64: string | undefined = body?.blend_file_base64;

    if (!blendFileBase64) {
      return NextResponse.json(
        { error: "Missing blend_file_base64 in request body" },
        { status: 400 },
      );
    }

    // Call Modal estimation endpoint directly
    const modalResponse = await fetch("https://ksshalini1--blend-renderer-estimate-render-time.modal.run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        blend_file_base64: blendFileBase64
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
