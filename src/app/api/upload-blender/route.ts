import { NextRequest, NextResponse } from "next/server";
import { Sandbox } from "e2b";
import { readFile } from "fs/promises";
import { join } from "path";
import { inngest } from "@/inngest/client";

export const runtime = "nodejs";
export const maxDuration = 300;

type BlendFrameData = {
  frame_start?: number;
  frame_end?: number;
  frame_count?: number;
  fps?: number;
  error?: string;
  error_type?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

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
    // Increased timeout to 120 seconds for complex files
    // Suppress Blender's stdout warnings by redirecting ONLY stdout to /dev/null
    // Keep stderr available for JSON output and error detection (Python script outputs JSON to stderr)
    // Capture actual exit code before || true masks it
    const command = `(timeout 120 blender --background --factory-startup --disable-autoexec --python ${scriptSandboxPath} -- ${sandboxFilePath} > /dev/null; EXIT=$?; echo "EXIT_CODE:$EXIT" >&2; exit $EXIT) 2>&1; true`;
    let result: { exitCode?: number; stdout?: string; stderr?: string };
    try {
      // Use timeoutMs: 0 so E2B doesn't kill the command early.
      // The shell-level `timeout 25` around Blender will still enforce a hard cap.
      result = await sandbox.commands.run(command, {
        timeoutMs: 0,
      });
    } catch (error: unknown) {
      // E2B SDK throws CommandExitError when exit code is non-zero
      // Extract the result from the error object
      if (
        typeof error === "object" &&
        error !== null &&
        "exitCode" in error &&
        ("stdout" in error || "stderr" in error)
      ) {
        const e = error as { exitCode?: number; stdout?: string; stderr?: string };
        result = {
          exitCode: e.exitCode,
          stdout: e.stdout || "",
          stderr: e.stderr || "",
        };
      } else {
        // Re-throw if it's not a CommandExitError
        throw error;
      }
    }

    // Extract actual exit code from output if present
    let actualExitCode = result.exitCode;
    const exitCodeMatch = (result.stderr || result.stdout || "").match(/EXIT_CODE:(\d+)/);
    if (exitCodeMatch) {
      actualExitCode = parseInt(exitCodeMatch[1], 10);
    }

    // Check for segmentation fault in bash error messages (even if exit code is 0)
    const allOutput = (result.stderr || "") + (result.stdout || "");
    const hasSegfault = allOutput.includes("Segmentation fault") || 
                        allOutput.includes("segfault") || 
                        allOutput.includes("SIGSEGV") ||
                        allOutput.match(/\d+\s+Segmentation fault/);
    
    // Check for timeout termination (exit code 124 or "terminated" message)
    // Also check for "[unknown] terminated" which appears when timeout kills the process
    const hasTimeoutTermination = actualExitCode === 124 || 
                                  actualExitCode === 143 || // SIGTERM (128 + 15)
                                  allOutput.includes("terminated") ||
                                  allOutput.includes("[unknown] terminated") ||
                                  allOutput.match(/\d+:\s*\[unknown\]\s*terminated/i) ||
                                  allOutput.match(/timeout:\s*command\s+terminated/i);

    // Check for timeout termination first
    if (hasTimeoutTermination) {
      throw new Error(
        `Blender frame extraction timed out after 120 seconds.\n` +
        `The file is taking too long to process. This usually means:\n` +
        `- The file is extremely complex with many objects/animations\n` +
        `- The file contains features that require extensive processing\n` +
        `- The file may be corrupted or have compatibility issues\n\n` +
        `Suggestions:\n` +
        `- Try opening the file in Blender GUI first to verify it loads\n` +
        `- Simplify the file by removing unnecessary objects or features\n` +
        `- Save the file in a newer Blender format if using an old version`
      );
    }
    
    // Check for segmentation fault or crash (exit code 139 = SIGSEGV, or detected in output)
    if (actualExitCode === 139 || hasSegfault) {
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
              const responseFrameData = {
                frameStart: fallbackData.frame_start,
                frameEnd: fallbackData.frame_end,
                frameCount: fallbackData.frame_count,
                fps: fallbackData.fps,
              };

              // Auto-trigger Inngest render function after successful frame detection
              try {
                await inngest.send({
                  name: "render/invoked",
                  data: {
                    sandboxId: sandbox.sandboxId,
                    frameData: responseFrameData,
                  },
                });
                console.log("Auto-triggered render function for sandbox:", sandbox.sandboxId);
              } catch (inngestError) {
                console.error("Failed to trigger Inngest render function:", inngestError);
              }

              return NextResponse.json({
                success: true,
                frameData: responseFrameData,
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
      // Remove EXIT_CODE line from output before parsing
      const cleanOutput = errorOutput.replace(/EXIT_CODE:\d+/g, "").trim();
      const jsonMatch = cleanOutput.match(/\{[^{}]*"error"[^{}]*\}/);
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
    if (actualExitCode !== 0 && actualExitCode !== undefined) {
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
    // Remove EXIT_CODE marker lines before parsing
    const outputText = (result.stderr || result.stdout || "").replace(/EXIT_CODE:\d+/g, "").trim();
    let frameData: BlendFrameData;
    
    try {
      // Extract JSON from output (should be clean since we suppressed stdout)
      // Try to find and parse JSON objects from the output
      const lines = outputText.split('\n');
      let parsedData: unknown = null;
      
      // First, try to find a line that looks like our JSON output
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{') && (trimmed.includes('"frame_start"') || trimmed.includes('"error"'))) {
          try {
            const candidate: unknown = JSON.parse(trimmed);
            // Verify it has the expected structure
            if (
              typeof candidate === "object" &&
              candidate !== null &&
              ("frame_start" in candidate || "error" in candidate)
            ) {
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
                const parsed: unknown = JSON.parse(candidate);
                if (
                  typeof parsed === "object" &&
                  parsed !== null &&
                  ("frame_start" in parsed || "error" in parsed)
                ) {
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
        // Check if there was a timeout termination or segfault even if exit code is 0 (due to || true)
        const allOutputForCheck = (result.stderr || "") + (result.stdout || "");
        const hasTimeoutInOutput = actualExitCode === 124 || 
                                   allOutputForCheck.includes("terminated") ||
                                   allOutputForCheck.match(/\d+:\s*\[unknown\]\s*terminated/i);
        
        if (hasTimeoutInOutput) {
          throw new Error(
            `Blender frame extraction timed out after 120 seconds.\n` +
            `The file is taking too long to process. This usually means:\n` +
            `- The file is extremely complex with many objects/animations\n` +
            `- The file contains features that require extensive processing\n` +
            `- The file may be corrupted or have compatibility issues\n\n` +
            `Suggestions:\n` +
            `- Try opening the file in Blender GUI first to verify it loads\n` +
            `- Simplify the file by removing unnecessary objects or features\n` +
            `- Save the file in a newer Blender format if using an old version`
          );
        }
        
        if (allOutputForCheck.includes("Segmentation fault") || 
            allOutputForCheck.includes("segfault") || 
            allOutputForCheck.match(/\d+\s+Segmentation fault/)) {
          // Try fallback before throwing segfault error
          try {
            const fallbackCommand = `python3 /tmp/read_blend_header.py ${sandboxFilePath} 2>&1`;
            const fallbackResult = await sandbox.commands.run(fallbackCommand, {
              timeoutMs: 5000,
            });
            
            const fallbackOutput = fallbackResult.stderr || fallbackResult.stdout || "";
            const fallbackJsonMatch = fallbackOutput.match(/\{[\s\S]*?\}/);
            if (fallbackJsonMatch) {
              try {
                const fallbackData = JSON.parse(fallbackJsonMatch[0]);
                if (fallbackData.frame_start !== undefined) {
                  const responseFrameData = {
                    frameStart: fallbackData.frame_start,
                    frameEnd: fallbackData.frame_end,
                    frameCount: fallbackData.frame_count,
                    fps: fallbackData.fps,
                  };

                  try {
                    await inngest.send({
                      name: "render/invoked",
                      data: {
                        sandboxId: sandbox.sandboxId,
                        frameData: responseFrameData,
                      },
                    });
                    console.log("Auto-triggered render function for sandbox:", sandbox.sandboxId);
                  } catch (inngestError) {
                    console.error("Failed to trigger Inngest render function:", inngestError);
                  }

                  return NextResponse.json({
                    success: true,
                    frameData: responseFrameData,
                    sandboxId: sandbox.sandboxId,
                    warning: fallbackData.note || "Used fallback method - Blender crashed on file open",
                  });
                }
              } catch {
                // Fallback parsing failed, continue with error
              }
            }
          } catch {
            // Fallback failed, continue with error
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
        
        // If no JSON found and exit code was non-zero, provide detailed error
        if (actualExitCode !== 0 && actualExitCode !== undefined) {
          const errorOutput = result.stderr || result.stdout || "";
          throw new Error(
            `Blender failed to process the file (exit code: ${actualExitCode}). ` +
            `The file may be incompatible, corrupted, or require features not available in headless mode.\n` +
            `Error output: ${errorOutput.substring(0, 1000)}`
          );
        }
        // If exit code was 0 but no JSON, something else went wrong
        const debugInfo = `stderr: ${result.stderr?.substring(0, 1000) || 'empty'}, stdout: ${result.stdout?.substring(0, 1000) || 'empty'}, exitCode: ${result.exitCode}, actualExitCode: ${actualExitCode}`;
        throw new Error(`No JSON found in Blender output. ${debugInfo}`);
      }
      
      frameData = (isRecord(parsedData) ? (parsedData as BlendFrameData) : {}) as BlendFrameData;
    } catch (parseError) {
      // If parsing fails, provide more context
      const errorMsg = parseError instanceof Error ? parseError.message : String(parseError);
      const debugInfo = `stderr: ${result.stderr?.substring(0, 1000) || 'empty'}, stdout: ${result.stdout?.substring(0, 1000) || 'empty'}, exitCode: ${result.exitCode}`;
      throw new Error(`Failed to parse Blender output: ${errorMsg}. ${debugInfo}`);
    }

    // Check for errors in the parsed data (script outputs error JSON on failure)
    if (typeof frameData.error === "string" && frameData.error.length > 0) {
      throw new Error(
        `Blender script error: ${frameData.error} (error_type: ${typeof frameData.error_type === "string" ? frameData.error_type : "unknown"})`
      );
    }

    // Verify we have the expected frame data
    if (typeof frameData.frame_start !== "number" || typeof frameData.frame_end !== "number") {
      throw new Error(`Invalid frame data received: ${JSON.stringify(frameData)}`);
    }

    // Prepare frame data for response and Inngest
    const responseFrameData = {
      frameStart: frameData.frame_start,
      frameEnd: frameData.frame_end,
      frameCount: typeof frameData.frame_count === "number" ? frameData.frame_count : undefined,
      fps: typeof frameData.fps === "number" ? frameData.fps : undefined,
    };

    // Auto-trigger Inngest render function after successful frame detection
    try {
      await inngest.send({
        name: "render/invoked",
        data: {
          sandboxId: sandbox.sandboxId,
          frameData: responseFrameData,
        },
      });
      console.log("Auto-triggered render function for sandbox:", sandbox.sandboxId);
    } catch (inngestError) {
      // Log error but don't fail the upload - frame detection was successful
      console.error("Failed to trigger Inngest render function:", inngestError);
      // Continue to return success response with frame data
    }

    // Return frame data and sandbox ID
    // Note: Don't kill the sandbox - Inngest will use it for rendering
    return NextResponse.json({
      success: true,
      frameData: responseFrameData,
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
