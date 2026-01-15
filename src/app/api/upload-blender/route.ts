import { NextRequest, NextResponse } from "next/server";
import { Sandbox } from "e2b";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

export async function POST(request: NextRequest) {
  let tempFilePath: string | null = null;
  let sandbox: Sandbox | null = null;

  try {
    // Parse multipart form data
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json(
        { error: "No file provided" },
        { status: 400 }
      );
    }

    // Validate file type
    if (!file.name.toLowerCase().endsWith(".blend")) {
      return NextResponse.json(
        { error: "Only .blend files are supported" },
        { status: 400 }
      );
    }

    // Save file temporarily
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);
    tempFilePath = join(tmpdir(), `blender-${Date.now()}-${file.name}`);
    await writeFile(tempFilePath, buffer);

    // Create E2B sandbox with extended timeout to keep it alive for Inngest
    // Timeout is in milliseconds (1 hour = 3600000ms)
    sandbox = await Sandbox.create({
      template: "blender-headless-template",
      timeoutMs: 3600000, // 1 hour timeout
    });

    // Upload Blender file to sandbox
    const sandboxFilePath = "/tmp/uploaded.blend";
    await sandbox.files.write(sandboxFilePath, buffer);

    // The extract_frames.py script is already included in the template at /tmp/extract_frames.py
    const scriptSandboxPath = "/tmp/extract_frames.py";

    // Run Blender to extract frame count
    const process = await sandbox.process.start({
      cmd: [
        "blender",
        "--background",
        "--python",
        scriptSandboxPath,
        "--",
        sandboxFilePath,
      ],
    });

    // Wait for process to complete and capture output
    const output = await process.wait();
    
    if (output.exitCode !== 0) {
      const errorOutput = output.stderr || output.stdout || "Unknown error";
      throw new Error(`Blender execution failed: ${errorOutput}`);
    }

    // Parse JSON output from Blender script
    const outputText = output.stdout || "";
    let frameData;
    
    try {
      // Extract JSON from output (might have other text before/after)
      const jsonMatch = outputText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON found in Blender output");
      }
      frameData = JSON.parse(jsonMatch[0]);
    } catch (parseError) {
      throw new Error(`Failed to parse Blender output: ${outputText}`);
    }

    // Check for errors in the parsed data
    if (frameData.error) {
      throw new Error(`Blender script error: ${frameData.error}`);
    }

    // Return frame data and sandbox ID
    return NextResponse.json({
      success: true,
      frameData: {
        frameStart: frameData.frame_start,
        frameEnd: frameData.frame_end,
        frameCount: frameData.frame_count,
        fps: frameData.fps,
      },
      sandboxId: sandbox.sandboxId,
    });
  } catch (error) {
    console.error("Error processing Blender file:", error);
    
    // Clean up sandbox if it was created
    if (sandbox) {
      try {
        await sandbox.close();
      } catch (closeError) {
        console.error("Error closing sandbox:", closeError);
      }
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to process Blender file",
      },
      { status: 500 }
    );
  } finally {
    // Clean up temporary file
    if (tempFilePath) {
      try {
        await unlink(tempFilePath);
      } catch (unlinkError) {
        console.error("Error deleting temp file:", unlinkError);
      }
    }
  }
}
