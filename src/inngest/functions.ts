import { inngest } from "./client";
import { getSandboxService } from "@/services/sandbox.service";
import { getBlenderService } from "@/services/blender.service";
import { getStorageService } from "@/services/storage.service";
import { BlenderError, SandboxError } from "@/lib/errors/render-errors";
import { hasSegmentationFault, hasTimeout, extractExitCode } from "@/lib/errors/error-parser";
import { toBuffer } from "@/lib/utils/sandbox-output.util";
import { blenderConfig } from "@/config/blender.config";
import type { FrameData, SandboxInstance } from "@/types";

export const renderFunction = inngest.createFunction(
  { id: "render-function" },
  { event: "render/invoked" },
  async ({ event, step }) => {
    const sandboxId = event.data.sandboxId as string | undefined;
    const frameData = event.data.frameData as FrameData | undefined;

    if (!sandboxId) {
      throw new Error("sandboxId is required in event data");
    }

    const sandboxService = getSandboxService();
    const blenderService = getBlenderService();
    const storageService = getStorageService();

    try {
      // Step 1: Connect to existing sandbox and verify file
      await step.run("connect-to-e2b-sandbox", async () => {
        const sandbox = await sandboxService.connect(sandboxId, {
          timeoutMs: 3600000, // 1 hour timeout
        });
        console.log("Connected to existing E2B sandbox:", sandbox.sandboxId);

        // Verify the Blender file exists in the sandbox
        const hasBlenderFile = await sandboxService.fileExists(sandbox, blenderConfig.sandbox.uploadedBlendPath);
        if (!hasBlenderFile) {
          throw new SandboxError("Blender file not found in sandbox", sandboxId);
        }

        console.log("Blender file found in sandbox");
        // Don't return sandbox - it can't be serialized by Inngest
        return { success: true };
      });

      // Step 2: Upload render_mp4.py script to sandbox
      await step.run("upload-render-script", async () => {
        const sandbox = await sandboxService.connect(sandboxId, {
          timeoutMs: 3600000,
        });
        await sandboxService.uploadScript(sandbox, "render_mp4");
        console.log("Uploaded render_mp4.py script to sandbox");
        return { success: true };
      });

      // Step 3: Execute Blender render command
      const renderResult = await step.run("execute-blender-render", async () => {
        const sandbox = await sandboxService.connect(sandboxId, {
          timeoutMs: 3600000,
        });

        const scriptPath = blenderConfig.sandbox.renderMp4ScriptPath;
        const blendFilePath = blenderConfig.sandbox.uploadedBlendPath;

        // Build render command
        const command = blenderService.buildRenderCommand(scriptPath, blendFilePath, {
          timeoutSeconds: blenderConfig.timeouts.render,
        });

        console.log("Starting Blender render...");
        const result = await sandboxService.executeCommand(sandbox, command, {
          timeoutMs: 0, // Use shell-level timeout
        });

        // Extract exit code
        const allOutput = (result.stderr || "") + (result.stdout || "");
        const actualExitCode = extractExitCode(allOutput, result.exitCode);

        // Check for timeout
        if (hasTimeout(allOutput, actualExitCode)) {
          throw BlenderError.fromTimeout(blenderConfig.timeouts.render, { sandboxId });
        }

        // Check for segfault
        if (hasSegmentationFault(allOutput) || actualExitCode === 139) {
          const renderData = blenderService.parseRenderOutput(allOutput);
          throw BlenderError.fromSegmentationFault({
            sandboxId,
            error: renderData.error,
          });
        }

        // Parse render result
        const renderData = blenderService.parseRenderOutput(allOutput);
        if (renderData.error) {
          throw BlenderError.fromScriptError(
            renderData.error,
            renderData.error_type || "UNKNOWN",
            { sandboxId }
          );
        }

        // Check exit code
        if (actualExitCode !== 0 && actualExitCode !== undefined && actualExitCode !== 1) {
          throw new BlenderError(
            `Blender render failed with exit code ${actualExitCode}`,
            "RENDER_ERROR",
            { sandboxId, exitCode: actualExitCode }
          );
        }

        // Verify output file exists
        const hasOutput = await sandboxService.fileExists(sandbox, blenderConfig.sandbox.outputMp4Path);
        if (!hasOutput) {
          throw new BlenderError("Output MP4 file was not created", "NO_OUTPUT", { sandboxId });
        }

        console.log("Blender render completed successfully");
        return { renderData };
      });

      // Step 4: Read MP4 file from sandbox
      const videoData = await step.run("read-mp4-file", async () => {
        const sandbox = await sandboxService.connect(sandboxId, {
          timeoutMs: 3600000,
        });
        const buffer = await sandboxService.readFile(sandbox, blenderConfig.sandbox.outputMp4Path);
        console.log(`Read MP4 file: ${buffer.length} bytes`);
        return buffer;
      });

      // Step 5: Store video file in storage
      const videoPath = await step.run("store-video-file", async () => {
        const fileName = `${sandboxId}.mp4`;
        const buffer = toBuffer(videoData);

        // Upload to storage (Supabase or local)
        await storageService.upload(fileName, buffer, {
          bucket: "renders",
          contentType: "video/mp4",
        });

        console.log(`Stored video file: ${fileName}`);
        return fileName;
      });

      // Step 6: Clean up sandbox
      await step.run("cleanup-sandbox", async () => {
        try {
          const sandbox = await sandboxService.connect(sandboxId, {
            timeoutMs: 10000, // Shorter timeout for cleanup
          });
          await sandboxService.kill(sandbox);
          console.log("Sandbox cleaned up");
        } catch (error) {
          // Sandbox may already be dead, ignore cleanup errors
          console.warn("Cleanup warning (sandbox may already be dead):", error);
        }
        return { success: true };
      });

      return {
        success: true,
        videoUrl: videoPath,
        sandboxId,
        frameData: frameData || renderResult.renderData,
      };
    } catch (error) {
      // Clean up sandbox on error (best effort)
      try {
        const sandbox = await sandboxService.connect(sandboxId, {
          timeoutMs: 10000, // Shorter timeout for cleanup
        });
        await sandboxService.kill(sandbox);
      } catch {
        // Ignore cleanup errors - sandbox may already be dead
      }
      throw error;
    }
  }
);
