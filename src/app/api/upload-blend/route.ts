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

    // Read the file buffer for validation
    const fileBuffer = Buffer.from(await file.arrayBuffer());
    
    // Debug logging
    console.log("File info:", {
      name: file.name,
      size: fileBuffer.length,
      type: file.type,
      firstBytesHex: fileBuffer.subarray(0, 20).toString('hex'),
      firstBytesAscii: fileBuffer.subarray(0, 20).toString('ascii').replace(/[^\x20-\x7E]/g, '.'),
      rawFirstBytes: Array.from(fileBuffer.subarray(0, 20))
    });
    
    // Blender files must start with "BLENDER" (7 bytes ASCII)
    const blenderSignature = Buffer.from('BLENDER');
    
    // TEMPORARILY DISABLE VALIDATION FOR TESTING
    // We'll upload the file regardless and let Modal handle validation
    console.log("WARNING: Skipping Blender file validation for debugging");
    
    /*
    if (fileBuffer.length < blenderSignature.length || 
        !fileBuffer.subarray(0, blenderSignature.length).equals(blenderSignature)) {
      
      // Check if it's a common compressed format that was renamed
      const zipSignature = Buffer.from([0x50, 0x4B]); // PK
      const gzipSignature = Buffer.from([0x1F, 0x8B]);
      const rarSignature = Buffer.from([0x52, 0x61, 0x72, 0x21]); // Rar!
      const sevenZipSignature = Buffer.from([0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C]); // 7z
      
      let fileType = "unknown";
      if (fileBuffer.subarray(0, 2).equals(zipSignature)) {
        fileType = "ZIP archive";
      } else if (fileBuffer.subarray(0, 2).equals(gzipSignature)) {
        fileType = "GZIP archive";
      } else if (fileBuffer.subarray(0, 4).equals(rarSignature)) {
        fileType = "RAR archive";
      } else if (fileBuffer.subarray(0, 6).equals(sevenZipSignature)) {
        fileType = "7-Zip archive";
      }
      
      return NextResponse.json(
        { 
          error: `Invalid .blend file. This appears to be a ${fileType}, not a Blender file. Please extract the actual .blend file from the archive and upload that instead. If this is already a .blend file from Blender 5.0.1, the file may be corrupted.`,
          debug: {
            firstBytes: fileBuffer.subarray(0, 20).toString('hex'),
            expectedSignature: 'BLENDER',
            detectedType: fileType,
            fileSize: fileBuffer.length,
            fileName: file.name
          }
        },
        { status: 400 },
      );
    }
    
    // Additional validation: check pointer size and endianness bytes
    if (fileBuffer.length >= 12) {
      const pointerSize = String.fromCharCode(fileBuffer[7]);
      const endianness = String.fromCharCode(fileBuffer[8]);
      const version = fileBuffer.subarray(9, 12).toString('ascii');
      
      console.log("Blender header info:", {
        pointerSize: pointerSize === '_' ? '32-bit' : pointerSize === '-' ? '64-bit' : 'unknown',
        endianness: endianness === 'v' ? 'little-endian' : endianness === 'V' ? 'big-endian' : 'unknown',
        version: version
      });
    }
    */

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

