import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { supabaseServerClient } from "@/lib/supabase-server";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "No file uploaded or invalid file field" },
        { status: 400 },
      );
    }

    const blendsBucket =
      process.env.SUPABASE_BLENDS_BUCKET ?? "blends";

    const id = randomUUID();
    const ext = ".blend";
    const path = `blends/${id}${ext}`;

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const { error: uploadError } = await supabaseServerClient.storage
      .from(blendsBucket)
      .upload(path, buffer, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });

    if (uploadError) {
      console.error("Supabase upload error:", uploadError);
      return NextResponse.json(
        { error: "Failed to upload file" },
        { status: 500 },
      );
    }

    const { data: signed, error: signedError } =
      await supabaseServerClient.storage
        .from(blendsBucket)
        .createSignedUrl(path, 60 * 60); // 1 hour

    if (signedError || !signed?.signedUrl) {
      console.error("Supabase signed URL error:", signedError);
      return NextResponse.json(
        { error: "Failed to create signed URL" },
        { status: 500 },
      );
    }

    return NextResponse.json({
      key: path,
      blendUrl: signed.signedUrl,
    });
  } catch (error) {
    console.error("Unexpected error in upload-blend:", error);
    return NextResponse.json(
      { error: "Unexpected server error" },
      { status: 500 },
    );
  }
}

