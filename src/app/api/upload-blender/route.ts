import { NextRequest, NextResponse } from "next/server";
import { Sandbox } from "e2b";

export async function POST(request: NextRequest) {
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

    // Read file into memory (no temporary file on disk)
    const bytes = await file.arrayBuffer();

    // Create E2B sandbox with extended timeout to keep it alive for Inngest
    // Timeout is in milliseconds (1 hour = 3600000ms)
    sandbox = await Sandbox.create("blender-headless-template", {
      timeoutMs: 3600000, // 1 hour timeout
    });

    // Upload Blender file to sandbox (use ArrayBuffer directly)
    const sandboxFilePath = "/tmp/uploaded.blend";
    await sandbox.files.write(sandboxFilePath, bytes);

    // The extract_frames.py script is already included in the template at /tmp/extract_frames.py
    const scriptSandboxPath = "/tmp/extract_frames.py";

    // Run Blender to extract frame count using E2B SDK v2 commands API
    const command = `blender --background --python ${scriptSandboxPath} -- ${sandboxFilePath}`;
    const result = await sandbox.commands.run(command, {
      timeoutMs: 60000, // 60 seconds timeout for Blender execution
    });

    if (result.exitCode !== 0) {
      const errorOutput = result.stderr || result.stdout || "Unknown error";
      throw new Error(`Blender execution failed: ${errorOutput}`);
    }

    // Parse JSON output from Blender script
    const outputText = result.stdout || "";
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
        await sandbox.kill();
      } catch (killError) {
        console.error("Error killing sandbox:", killError);
      }
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Failed to process Blender file",
      },
      { status: 500 }
    );
  }
}
