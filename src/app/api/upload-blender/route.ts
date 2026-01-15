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
    // Suppress Blender's stdout warnings by redirecting to /dev/null
    // The Python script outputs JSON to stderr, which will be captured separately
    const command = `blender --background --no-window-focus --python ${scriptSandboxPath} -- ${sandboxFilePath} > /dev/null`;
    const result = await sandbox.commands.run(command, {
      timeoutMs: 60000, // 60 seconds timeout for Blender execution
    });

    // The Python script outputs JSON to stderr to avoid Blender's stdout warnings
    // Check stderr first (where our JSON is), then stdout as fallback
    const outputText = result.stderr || result.stdout || "";
    let frameData;
    
    try {
      // Extract JSON from output (should be clean since we suppressed stdout)
      // Try to find and parse JSON objects from the output
      const lines = outputText.split('\n');
      let parsedData: any = null;
      
      // First, try to find a line that looks like our JSON output
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{') && (trimmed.includes('"frame_start"') || trimmed.includes('"error"'))) {
          try {
            const candidate = JSON.parse(trimmed);
            // Verify it has the expected structure
            if (candidate.frame_start !== undefined || candidate.error !== undefined) {
              parsedData = candidate;
              break;
            }
          } catch {
            // Not valid JSON, continue
          }
        }
      }
      
      // If not found line-by-line, try to extract JSON from the entire output
      if (!parsedData) {
        // Try to find JSON objects by looking for balanced braces
        let braceCount = 0;
        let startIdx = -1;
        for (let i = 0; i < outputText.length; i++) {
          if (outputText[i] === '{') {
            if (braceCount === 0) startIdx = i;
            braceCount++;
          } else if (outputText[i] === '}') {
            braceCount--;
            if (braceCount === 0 && startIdx !== -1) {
              const candidate = outputText.substring(startIdx, i + 1);
              try {
                const parsed = JSON.parse(candidate);
                if (parsed.frame_start !== undefined || parsed.error !== undefined) {
                  parsedData = parsed;
                  break;
                }
              } catch {
                // Not valid JSON, continue searching
              }
            }
          }
        }
      }
      
      if (!parsedData) {
        // If no JSON found, check if there's an error in the output
        if (result.exitCode !== 0) {
          throw new Error(`Blender execution failed with exit code ${result.exitCode}: ${outputText}`);
        }
        throw new Error(`No JSON found in Blender output. stderr: ${result.stderr?.substring(0, 500) || 'empty'}, stdout: ${result.stdout?.substring(0, 500) || 'empty'}`);
      }
      
      frameData = parsedData;
    } catch (parseError) {
      // If parsing fails, provide more context
      const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
      const debugInfo = `stderr: ${result.stderr?.substring(0, 500) || 'empty'}, stdout: ${result.stdout?.substring(0, 500) || 'empty'}`;
      throw new Error(`Failed to parse Blender output: ${errorMsg}. ${debugInfo}`);
    }

    // Check exit code after parsing (script exits with 0 on success, 1 on error)
    if (result.exitCode !== 0) {
      const errorOutput = result.stderr || result.stdout || "Unknown error";
      throw new Error(`Blender execution failed with exit code ${result.exitCode}: ${errorOutput}`);
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
