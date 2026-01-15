import { NextRequest, NextResponse } from "next/server";
import { Sandbox } from "e2b";
import { readFile } from "fs/promises";
import { join } from "path";

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

    // Upload the extract_frames.py script to sandbox
    // Read the script from the e2b-template directory
    const scriptPath = join(process.cwd(), "e2b-template", "extract_frames.py");
    let scriptContent: string;
    try {
      scriptContent = await readFile(scriptPath, "utf-8");
    } catch (readError) {
      throw new Error(`Failed to read extract_frames.py script from ${scriptPath}: ${readError instanceof Error ? readError.message : String(readError)}`);
    }
    const scriptSandboxPath = "/tmp/extract_frames.py";
    await sandbox.files.write(scriptSandboxPath, scriptContent);

    // Also upload fallback header reader script
    const fallbackScriptPath = join(process.cwd(), "e2b-template", "read_blend_header.py");
    try {
      const fallbackContent = await readFile(fallbackScriptPath, "utf-8");
      await sandbox.files.write("/tmp/read_blend_header.py", fallbackContent);
    } catch {
      // Fallback script is optional, continue without it
    }

    // Run Blender to extract frame count using E2B SDK v2 commands API
    // Use factory-startup to avoid loading user preferences (faster, more stable)
    // Add --disable-autoexec to skip auto-execution scripts that might cause issues
    // Suppress Blender's stdout warnings by redirecting to /dev/null
    // The Python script outputs JSON to stderr, which will be captured separately
    const command = `timeout 25 blender --background --factory-startup --disable-autoexec --python ${scriptSandboxPath} -- ${sandboxFilePath} > /dev/null 2>&1 || true`;
    let result;
    try {
      result = await sandbox.commands.run(command, {
        timeoutMs: 30000, // Reduced to 30 seconds - complex files should load faster with optimized flags
      });
    } catch (error: any) {
      // E2B SDK throws CommandExitError when exit code is non-zero
      // Extract the result from the error object
      if (error.exitCode !== undefined && (error.stdout !== undefined || error.stderr !== undefined)) {
        result = {
          exitCode: error.exitCode,
          stdout: error.stdout || "",
          stderr: error.stderr || "",
        };
      } else {
        // Re-throw if it's not a CommandExitError
        throw error;
      }
    }

    // Check for segmentation fault or crash (exit code 139 = SIGSEGV)
    if (result.exitCode === 139) {
      // Try fallback: read file header directly without opening in Blender
      try {
        const fallbackCommand = `python3 /tmp/read_blend_header.py ${sandboxFilePath} 2>&1`;
        const fallbackResult = await sandbox.commands.run(fallbackCommand, {
          timeoutMs: 5000,
        });
        
        // Try to parse fallback result
        const fallbackOutput = fallbackResult.stderr || fallbackResult.stdout || "";
        const fallbackJsonMatch = fallbackOutput.match(/\{[\s\S]*?\}/);
        if (fallbackJsonMatch) {
          try {
            const fallbackData = JSON.parse(fallbackJsonMatch[0]);
            if (fallbackData.frame_start !== undefined) {
              // Use fallback data
              return NextResponse.json({
                success: true,
                frameData: {
                  frameStart: fallbackData.frame_start,
                  frameEnd: fallbackData.frame_end,
                  frameCount: fallbackData.frame_count,
                  fps: fallbackData.fps,
                },
                sandboxId: sandbox.sandboxId,
                warning: fallbackData.note || "Used fallback method - values may be estimated",
              });
            }
          } catch {
            // Fallback parsing failed, continue with error
          }
        }
      } catch {
        // Fallback failed, continue with original error
      }

      const errorOutput = result.stderr || result.stdout || "";
      // Try to extract any JSON error that might have been output before the crash
      const jsonMatch = errorOutput.match(/\{[^{}]*"error"[^{}]*\}/);
      if (jsonMatch) {
        try {
          const errorData = JSON.parse(jsonMatch[0]);
          throw new Error(
            `Blender crashed: ${errorData.error || 'Segmentation fault'}\n` +
            `This usually means the file contains features incompatible with headless processing.\n` +
            `Try opening the file in Blender GUI and saving it in a simpler format.`
          );
        } catch {
          // If JSON parsing fails, use default error
        }
      }
      throw new Error(
        `Blender crashed with segmentation fault while processing the file.\n` +
        `Possible causes:\n` +
        `- Complex physics simulations (rigid body, cloth, etc.)\n` +
        `- Custom addons or scripts required by the file\n` +
        `- File format incompatibility\n` +
        `- Corrupted file data\n\n` +
        `Suggestion: Open the file in Blender GUI, simplify or remove problematic features, and re-export.`
      );
    }

    // Check for other non-zero exit codes
    if (result.exitCode !== 0 && result.exitCode !== undefined) {
      const errorOutput = result.stderr || result.stdout || "";
      // Check if it's a known error pattern
      if (errorOutput.includes("Segmentation fault") || errorOutput.includes("core dumped")) {
        throw new Error(
          `Blender crashed while processing the file. The file may be incompatible or corrupted.\n` +
          `Error: ${errorOutput.substring(0, 500)}`
        );
      }
    }

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
        // If no JSON found and exit code was non-zero, provide detailed error
        if (result.exitCode !== 0) {
          const errorOutput = result.stderr || result.stdout || "";
          throw new Error(
            `Blender failed to process the file (exit code: ${result.exitCode}). ` +
            `The file may be incompatible, corrupted, or require features not available in headless mode.\n` +
            `Error output: ${errorOutput.substring(0, 1000)}`
          );
        }
        // If exit code was 0 but no JSON, something else went wrong
        const debugInfo = `stderr: ${result.stderr?.substring(0, 1000) || 'empty'}, stdout: ${result.stdout?.substring(0, 1000) || 'empty'}, exitCode: ${result.exitCode}`;
        throw new Error(`No JSON found in Blender output. ${debugInfo}`);
      }
      
      frameData = parsedData;
    } catch (parseError) {
      // If parsing fails, provide more context
      const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
      const debugInfo = `stderr: ${result.stderr?.substring(0, 1000) || 'empty'}, stdout: ${result.stdout?.substring(0, 1000) || 'empty'}, exitCode: ${result.exitCode}`;
      throw new Error(`Failed to parse Blender output: ${errorMsg}. ${debugInfo}`);
    }

    // Check for errors in the parsed data (script outputs error JSON on failure)
    if (frameData.error) {
      throw new Error(`Blender script error: ${frameData.error} (error_type: ${frameData.error_type || 'unknown'})`);
    }

    // Verify we have the expected frame data
    if (frameData.frame_start === undefined || frameData.frame_end === undefined) {
      throw new Error(`Invalid frame data received: ${JSON.stringify(frameData)}`);
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
