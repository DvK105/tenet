import { inngest } from "./client";
import { Sandbox } from "e2b";
import { readFile } from "fs/promises";
import { join } from "path";
import { writeFile } from "fs/promises";
import { mkdir } from "fs/promises";

// Simple in-memory cache for rendered videos (key: sandboxId, value: file path)
// In production, you'd want to use proper storage (S3, etc.)
const videoCache = new Map<string, string>();

export const renderFunction = inngest.createFunction(
  { id: "render-function" },
  { event: "render/invoked" },
  async ({ event, step }) => {
    const sandboxId = event.data.sandboxId as string | undefined;
    const frameData = event.data.frameData as {
      frameStart: number;
      frameEnd: number;
      frameCount: number;
      fps: number;
    } | undefined;

    if (!sandboxId) {
      throw new Error("sandboxId is required in event data");
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sandbox: any = null;

    try {
      // Step 1: Connect to existing sandbox
      const connectedSandbox = await step.run("connect-to-e2b-sandbox", async () => {
        const sbox = await Sandbox.connect(sandboxId, {
          timeoutMs: 3600000, // 1 hour timeout
        });
        console.log("Connected to existing E2B sandbox:", sbox.sandboxId);
        
        // Verify the Blender file exists in the sandbox
        const files = await sbox.files.list("/tmp");
        const blenderFile = files.find((f) => f.name === "uploaded.blend");
        
        if (!blenderFile) {
          throw new Error("Blender file not found in sandbox");
        }
        
        console.log("Blender file found in sandbox:", blenderFile.name);
        return sbox;
      });
      sandbox = connectedSandbox;

      // Step 2: Upload render_mp4.py script to sandbox
      await step.run("upload-render-script", async () => {
        if (!sandbox) {
          throw new Error("Sandbox not connected");
        }
        const scriptPath = join(process.cwd(), "e2b-template", "render_mp4.py");
        let scriptContent: string;
        try {
          scriptContent = await readFile(scriptPath, "utf-8");
        } catch (readError) {
          throw new Error(`Failed to read render_mp4.py script from ${scriptPath}: ${readError instanceof Error ? readError.message : String(readError)}`);
        }
        
        const scriptSandboxPath = "/tmp/render_mp4.py";
        await sandbox.files.write(scriptSandboxPath, scriptContent);
        console.log("Uploaded render_mp4.py script to sandbox");
        return scriptSandboxPath;
      });

      // Step 3: Execute Blender render command
      const renderResult = await step.run("execute-blender-render", async () => {
        if (!sandbox) {
          throw new Error("Sandbox not connected");
        }
        const scriptSandboxPath = "/tmp/render_mp4.py";
        const blendFilePath = "/tmp/uploaded.blend";
        const outputPath = "/tmp/output.mp4";

        // Use factory-startup and disable-autoexec for stability
        // Set a longer timeout for rendering (up to 1 hour)
        // Capture exit code before || true masks it, and preserve stderr for JSON output
        // Python script outputs JSON to stderr, so we preserve stderr
        const command = `(timeout 3600 blender --background --factory-startup --disable-autoexec --python ${scriptSandboxPath} -- ${blendFilePath}; EXIT=$?; echo "EXIT_CODE:$EXIT" >&2; exit $EXIT) 2>&1; true`;
        
        console.log("Starting Blender render...");
        let result;
        try {
          // Use timeoutMs: 0 so E2B doesn't add its own deadline;
          // the shell-level `timeout 3600` around Blender enforces the hard cap.
          result = await sandbox.commands.run(command, {
            timeoutMs: 0,
          });
        } catch (error: any) {
          // E2B SDK throws CommandExitError when exit code is non-zero
          if (error.exitCode !== undefined && (error.stdout !== undefined || error.stderr !== undefined)) {
            result = {
              exitCode: error.exitCode,
              stdout: error.stdout || "",
              stderr: error.stderr || "",
            };
          } else {
            throw error;
          }
        }

        // Extract actual exit code from output if present
        let actualExitCode = result.exitCode;
        const exitCodeMatch = (result.stderr || result.stdout || "").match(/EXIT_CODE:(\d+)/);
        if (exitCodeMatch) {
          actualExitCode = parseInt(exitCodeMatch[1], 10);
        }

        // Check for segmentation fault in output
        const allOutput = (result.stderr || "") + (result.stdout || "");
        const hasSegfault = allOutput.includes("Segmentation fault") || 
                            allOutput.includes("segfault") || 
                            allOutput.includes("SIGSEGV") ||
                            allOutput.match(/\d+\s+Segmentation fault/);

        // Parse render result from stderr (where our JSON is)
        // Remove EXIT_CODE marker lines before parsing
        let outputText = (result.stderr || result.stdout || "").replace(/EXIT_CODE:\d+/g, "").trim();
        let renderData: any = null;
        
        try {
          // Try to find JSON in output
          const lines = outputText.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('{') && (trimmed.includes('"success"') || trimmed.includes('"error"'))) {
              try {
                const candidate = JSON.parse(trimmed);
                if (candidate.success !== undefined || candidate.error !== undefined) {
                  renderData = candidate;
                  break;
                }
              } catch {
                // Not valid JSON, continue
              }
            }
          }
          
          // If not found line-by-line, try to extract JSON from entire output
          if (!renderData) {
            const jsonMatch = outputText.match(/\{[\s\S]*?\}/);
            if (jsonMatch) {
              renderData = JSON.parse(jsonMatch[0]);
            }
          }
        } catch (parseError) {
          console.error("Failed to parse render output:", parseError);
        }

        // Check for segfault before checking render data
        if (hasSegfault || actualExitCode === 139) {
          const errorMsg = renderData?.error || "Segmentation fault";
          throw new Error(
            `Blender crashed during render: ${errorMsg}\n` +
            `The file may contain features incompatible with headless rendering.\n` +
            `Try simplifying the file or removing complex features.`
          );
        }

        if (renderData && renderData.error) {
          throw new Error(`Blender render error: ${renderData.error} (error_type: ${renderData.error_type || 'unknown'})`);
        }

        if (actualExitCode !== 0 && actualExitCode !== undefined && actualExitCode !== 1) {
          throw new Error(`Blender render failed with exit code ${actualExitCode}. Output: ${outputText.substring(0, 1000)}`);
        }

        // Verify output file exists
        const files = await sandbox.files.list("/tmp");
        const outputFile = files.find((f: { name: string }) => f.name === "output.mp4");
        
        if (!outputFile) {
          throw new Error("Output MP4 file was not created");
        }

        console.log("Blender render completed successfully");
        return { renderData, outputPath };
      });

      // Step 4: Read MP4 file from sandbox
      const videoData = await step.run("read-mp4-file", async () => {
        if (!sandbox) {
          throw new Error("Sandbox not connected");
        }
        const outputPath = "/tmp/output.mp4";
        const videoBytes = await sandbox.files.read(outputPath);
        // Handle different return types from E2B SDK
        let buffer: Buffer;
        if (videoBytes && typeof videoBytes === 'object') {
          if ('byteLength' in videoBytes) {
            // It's an ArrayBuffer or ArrayBufferView
            buffer = Buffer.from(videoBytes as ArrayBuffer);
          } else if (Array.isArray(videoBytes)) {
            buffer = Buffer.from(videoBytes);
          } else {
            buffer = Buffer.from(String(videoBytes), 'binary');
          }
        } else if (typeof videoBytes === 'string') {
          buffer = Buffer.from(videoBytes, 'binary');
        } else {
          buffer = Buffer.from(String(videoBytes), 'binary');
        }
        console.log(`Read MP4 file: ${buffer.length} bytes`);
        return buffer;
      });

      // Step 5: Store video file locally (temporary solution)
      // In production, upload to S3 or similar storage
      const videoPath = await step.run("store-video-file", async () => {
        // Create public directory if it doesn't exist
        const publicDir = join(process.cwd(), "public", "renders");
        try {
          await mkdir(publicDir, { recursive: true });
        } catch {
          // Directory might already exist
        }

        // Store video file (videoData is a Buffer)
        const fileName = `${sandboxId}.mp4`;
        const filePath = join(publicDir, fileName);
        // Ensure videoData is a Buffer or Uint8Array
        // Handle serialized Buffer objects from Inngest step results
        let bufferToWrite: Buffer;
        if (Buffer.isBuffer(videoData)) {
          bufferToWrite = videoData;
        } else if (videoData && typeof videoData === 'object' && 'type' in videoData && videoData.type === 'Buffer' && 'data' in videoData && Array.isArray(videoData.data)) {
          // Handle serialized Buffer: { type: 'Buffer', data: number[] }
          bufferToWrite = Buffer.from(videoData.data);
        } else if (videoData instanceof Uint8Array) {
          bufferToWrite = Buffer.from(videoData);
        } else if (Array.isArray(videoData)) {
          bufferToWrite = Buffer.from(videoData);
        } else if (videoData instanceof ArrayBuffer) {
          bufferToWrite = Buffer.from(videoData);
        } else {
          // Fallback: try to convert to buffer
          bufferToWrite = Buffer.from(String(videoData), 'binary');
        }
        await writeFile(filePath, bufferToWrite);
        
        // Cache the path
        videoCache.set(sandboxId, `/renders/${fileName}`);
        
        console.log(`Stored video file: ${filePath}`);
        return `/renders/${fileName}`;
      });

      // Step 6: Clean up sandbox
      await step.run("cleanup-sandbox", async () => {
        if (!sandbox) {
          return;
        }
        try {
          await sandbox.kill();
          console.log("Sandbox cleaned up");
        } catch (error) {
          console.error("Error cleaning up sandbox:", error);
          // Don't throw - cleanup errors shouldn't fail the function
        }
      });

      return {
        success: true,
        videoUrl: videoPath,
        sandboxId,
        frameData: frameData || renderResult.renderData,
      };
    } catch (error) {
      // Clean up sandbox on error
      if (sandbox) {
        try {
          await sandbox.kill();
        } catch {
          // Ignore cleanup errors
        }
      }
      throw error;
    }
  }
);
