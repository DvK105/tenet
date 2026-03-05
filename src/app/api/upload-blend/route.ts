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
    
    // Blender files must start with "BLENDER" (7 bytes ASCII) or be Zstandard compressed
    const blenderSignature = Buffer.from('BLENDER');
    const zstdSignature = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]); // Zstandard magic number
    
    let isBlenderFile = false;
    let isCompressed = false;
    
    if (fileBuffer.length >= blenderSignature.length && 
        fileBuffer.subarray(0, blenderSignature.length).equals(blenderSignature)) {
      isBlenderFile = true;
    } else if (fileBuffer.length >= zstdSignature.length && 
               fileBuffer.subarray(0, zstdSignature.length).equals(zstdSignature)) {
      // This is a Zstandard compressed Blender file (Blender 3.0+ with compression enabled)
      isBlenderFile = true;
      isCompressed = true;
    }
    
    if (!isBlenderFile) {
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
          error: `Invalid .blend file. This appears to be a ${fileType}, not a Blender file. Please extract the actual .blend file from the archive and upload that instead.`,
          debug: {
            firstBytes: fileBuffer.subarray(0, 20).toString('hex'),
            expectedSignature: 'BLENDER or Zstandard compressed Blender file',
            detectedType: fileType,
            fileSize: fileBuffer.length,
            fileName: file.name
          }
        },
        { status: 400 },
      );
    }
    
    // Additional validation: check pointer size and endianness bytes (only for uncompressed files)
    if (!isCompressed && fileBuffer.length >= 12) {
      const pointerSize = String.fromCharCode(fileBuffer[7]);
      const endianness = String.fromCharCode(fileBuffer[8]);
      const version = fileBuffer.subarray(9, 12).toString('ascii');
      
      console.log("Blender header info:", {
        pointerSize: pointerSize === '_' ? '32-bit' : pointerSize === '-' ? '64-bit' : 'unknown',
        endianness: endianness === 'v' ? 'little-endian' : endianness === 'V' ? 'big-endian' : 'unknown',
        version: version,
        compressed: false
      });
    } else if (isCompressed) {
      console.log("Blender file info: Zstandard compressed (Blender 3.0+)");
    }

    const blendsBucket =
      process.env.SUPABASE_BLENDS_BUCKET ?? "blends";

    const id = randomUUID();
    const ext = ".blend";
    const path = `blends/${id}${ext}`;

    const { error: uploadError } = await supabaseServerClient.storage
      .from(blendsBucket)
      .upload(path, fileBuffer, {
        contentType: "application/x-blender", // Use proper MIME type for blend files
        upsert: false,
      });

    if (uploadError) {
      console.error("Supabase upload error:", uploadError);
      return NextResponse.json(
        { error: "Failed to upload file" },
        { status: 500 },
      );
    }

    // Update the file metadata to ensure correct content type
    const { error: updateError } = await supabaseServerClient.storage
      .from(blendsBucket)
      .update(path, fileBuffer, {
        contentType: "application/x-blender",
        upsert: true,
        metadata: { 
          originalName: file.name,
          uploadedAt: new Date().toISOString()
        }
      });

    if (updateError) {
      console.error("Supabase metadata update error:", updateError);
      // Don't fail the upload, just log the error
    }

    // Verify the uploaded file by downloading it immediately
    console.log("Verifying uploaded file...");
    const { data: downloadData, error: downloadError } = await supabaseServerClient.storage
      .from(blendsBucket)
      .download(path);
    
    if (downloadError) {
      console.error("Supabase download error:", downloadError);
    } else if (downloadData) {
      const downloadedBuffer = Buffer.from(await downloadData.arrayBuffer());
      console.log("Downloaded file verification:", {
        originalSize: fileBuffer.length,
        downloadedSize: downloadedBuffer.length,
        sizesMatch: fileBuffer.length === downloadedBuffer.length,
        originalFirstBytes: fileBuffer.subarray(0, 20).toString('hex'),
        downloadedFirstBytes: downloadedBuffer.subarray(0, 20).toString('hex'),
        buffersMatch: fileBuffer.equals(downloadedBuffer)
      });
      
      if (!fileBuffer.equals(downloadedBuffer)) {
        console.error("FILE CORRUPTION DETECTED: Uploaded and downloaded files don't match!");
      }
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

