import { NextRequest, NextResponse } from "next/server";
import { supabaseServerClient } from "@/lib/supabase-server";

const BLENDS_BUCKET = process.env.SUPABASE_BLENDS_BUCKET ?? "blends";
const MODAL_RENDER_FROM_URL =
  "https://ksshalini1--blend-renderer-render-from-url-http.modal.run";

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
    
    console.log("Signature detection:", {
      fileStart: fileBuffer.subarray(0, 8).toString('hex'),
      blenderSig: blenderSignature.toString('hex'),
      zstdSig: zstdSignature.toString('hex'),
      blenderMatch: fileBuffer.length >= blenderSignature.length && fileBuffer.subarray(0, blenderSignature.length).equals(blenderSignature),
      zstdMatch: fileBuffer.length >= zstdSignature.length && fileBuffer.subarray(0, zstdSignature.length).equals(zstdSignature)
    });
    
    if (fileBuffer.length >= blenderSignature.length && 
        fileBuffer.subarray(0, blenderSignature.length).equals(blenderSignature)) {
      isBlenderFile = true;
    } else if (fileBuffer.length >= zstdSignature.length && 
               fileBuffer.subarray(0, zstdSignature.length).equals(zstdSignature)) {
      // This is a Zstandard compressed Blender file (Blender 3.0+ with compression enabled)
      isBlenderFile = true;
      isCompressed = true;
    }
    
    console.log("File validation result:", { isBlenderFile, isCompressed });
    
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

    // Upload blend to Supabase, then start Modal render via URL (avoids large request body / socket close)
    console.log("Uploading blend to Supabase and starting Modal render...");

    const outputKey = `renders/${file.name.replace(/\.blend$/i, "")}_${Date.now()}.mp4`;
    const blendStorageKey = `temp/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

    // Retry helper with exponential backoff
    const uploadWithRetry = async (retries = 3): Promise<void> => {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          console.log(`Upload attempt ${attempt}/${retries}`);
          
          const { error: uploadError } = await supabaseServerClient.storage
            .from(BLENDS_BUCKET)
            .upload(blendStorageKey, fileBuffer, {
              contentType: "application/octet-stream",
              upsert: false,
            });

          if (uploadError) {
            throw uploadError;
          }
          
          console.log("Upload successful");
          return;
          
        } catch (error) {
          console.error(`Upload attempt ${attempt} failed:`, error);
          
          if (attempt === retries) {
            throw error;
          }
          
          // Exponential backoff: 1s, 2s, 4s
          const delay = Math.pow(2, attempt - 1) * 1000;
          console.log(`Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    };

    try {
      await uploadWithRetry();

      const { data: signed, error: signError } =
        await supabaseServerClient.storage
          .from(BLENDS_BUCKET)
          .createSignedUrl(blendStorageKey, 3600); // 1 hour for Modal to download

      if (signError || !signed?.signedUrl) {
        console.error("Signed URL error:", signError);
        return NextResponse.json(
          { error: "Failed to create signed URL for render" },
          { status: 500 }
        );
      }

      const modalResponse = await fetch(MODAL_RENDER_FROM_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          blend_url: signed.signedUrl,
          output_key: outputKey,
        }),
      });

      if (!modalResponse.ok) {
        const errorText = await modalResponse.text();
        console.error("Modal render-from-URL error:", errorText);
        return NextResponse.json(
          { error: "Failed to start render on Modal", details: errorText },
          { status: 500 }
        );
      }

      const modalData = (await modalResponse.json()) as { call_id?: string; error?: string };
      if (modalData.error) {
        return NextResponse.json(
          { error: "Modal rejected request", details: modalData.error },
          { status: 502 }
        );
      }

      const callId = modalData.call_id;
      if (!callId) {
        return NextResponse.json(
          { error: "Modal did not return a call ID" },
          { status: 502 }
        );
      }

      return NextResponse.json({
        callId,
        outputKey,
        fileName: file.name,
        fileSize: fileBuffer.length,
        compressed: isCompressed,
      });
    } catch (err) {
      console.error("Upload/render start error:", err);
      
      // Provide more specific error messages
      let errorMessage = "Failed to upload file or start render";
      let statusCode = 500;
      
      if (err instanceof Error) {
        if (err.message.includes('ECONNRESET') || err.message.includes('fetch failed')) {
          errorMessage = "Network connection failed during upload. Please check your internet connection and try again.";
          statusCode = 503; // Service Unavailable
        } else if (err.message.includes('timeout')) {
          errorMessage = "Upload timed out. The file may be too large or the network is slow. Please try again.";
          statusCode = 408; // Request Timeout
        } else if (err.message.includes('StorageUnknownError')) {
          errorMessage = "Storage service temporarily unavailable. Please try again in a few moments.";
          statusCode = 503;
        }
      }
      
      return NextResponse.json(
        { 
          error: errorMessage,
          details: err instanceof Error ? err.message : "Unknown error",
          retryable: statusCode === 503 || statusCode === 408
        },
        { status: statusCode }
      );
    }

  } catch (error) {
    console.error("Unexpected error in upload-blend:", error);
    return NextResponse.json(
      { error: "Unexpected server error" },
      { status: 500 },
    );
  }
}

