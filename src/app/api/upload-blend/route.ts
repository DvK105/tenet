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

    // Validate file extension and magic bytes
    if (!file.name.toLowerCase().endsWith('.blend')) {
      return NextResponse.json(
        { error: "File must have a .blend extension" },
        { status: 400 },
      );
    }

    // Check file magic bytes to ensure it's a valid Blender file
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    
    // Debug logging
    console.log("File info:", {
      name: file.name,
      size: fileBuffer.length,
      type: file.type,
      firstBytes: fileBuffer.subarray(0, 20).toString('hex')
    });
    
    // Blender files can have different magic bytes depending on version
    // Try multiple possible signatures
    const blenderSignatures = [
      Buffer.from('BLENDER'),
      Buffer.from('BLENDER-v'),  // Some versions
      Buffer.from('BLEN2'),      // Older versions
    ];
    
    let isValidBlend = false;
    for (const sig of blenderSignatures) {
      if (fileBuffer.length >= sig.length && fileBuffer.subarray(0, sig.length).equals(sig)) {
        isValidBlend = true;
        break;
      }
    }
    
    if (!isValidBlend) {
      return NextResponse.json(
        { 
          error: "Invalid .blend file: file does not have correct Blender format",
          debug: {
            firstBytes: fileBuffer.subarray(0, 20).toString('hex'),
            expectedSignatures: blenderSignatures.map(s => s.toString())
          }
        },
        { status: 400 },
      );
    }

    const blendsBucket =
      process.env.SUPABASE_BLENDS_BUCKET ?? "blends";

    const id = randomUUID();
    const ext = ".blend";
    const path = `blends/${id}${ext}`;

    const { error: uploadError } = await supabaseServerClient.storage
      .from(blendsBucket)
      .upload(path, fileBuffer, {
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

