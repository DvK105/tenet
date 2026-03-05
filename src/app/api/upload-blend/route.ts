import { NextRequest, NextResponse } from "next/server";

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

    // Send file directly to Modal for processing
    console.log("Sending file to Modal for processing...");
    
    // Convert Buffer to array of numbers for Modal API (more efficient)
    const fileBytes = Array.from(fileBuffer);
    
    // Generate output key for the rendered video
    const outputKey = `renders/${file.name.replace('.blend', '')}_${Date.now()}.mp4`;
    
    try {
      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minute timeout
      
      const modalResponse = await fetch("https://dvk105--blend-renderer-render-http.modal.run", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          blend_file_bytes: fileBytes,
          output_key: outputKey
        }),
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);

      if (!modalResponse.ok) {
        const errorText = await modalResponse.text();
        console.error("Modal processing error:", errorText);
        return NextResponse.json(
          { error: "Failed to process file with Modal", details: errorText },
          { status: 500 }
        );
      }

      const result = await modalResponse.text();
      
      // Check if the result is an error (Modal returns errors as strings with "ERROR:" prefix)
      if (result.startsWith("ERROR:")) {
        console.error("Modal render error:", result);
        return NextResponse.json(
          { error: "Rendering failed", details: result },
          { status: 500 }
        );
      }

      console.log("Modal processing successful:", result);

      return NextResponse.json({
        blendUrl: result, // Modal returns the signed URL of the rendered video
        outputKey: outputKey,
        fileName: file.name,
        fileSize: fileBuffer.length,
        compressed: isCompressed
      });

    } catch (modalError) {
      console.error("Modal communication error:", modalError);
      return NextResponse.json(
        { error: "Failed to communicate with Modal service" },
        { status: 500 }
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

