/**
 * Render service - Render orchestration logic
 */

import { getStorageService } from "./storage.service";
import { getSandboxService } from "./sandbox.service";
import { calculateProgress, calculateETA } from "@/lib/utils/progress-calculator.util";
import { decodeSandboxText } from "@/lib/utils/sandbox-output.util";
import { parseJsonSafe } from "@/lib/utils/json-parser.util";
import type { RenderStatus, SandboxProgress } from "@/types";

/**
 * Render service for render status and progress
 */
export class RenderService {
  /**
   * Get render status (checks Supabase, local, then sandbox)
   */
  async getStatus(renderId: string): Promise<RenderStatus> {
    const storageService = getStorageService();
    const videoFileName = `${renderId}.mp4`;

    // Check Supabase Storage first
    if (await storageService.exists(videoFileName, "renders")) {
      try {
        const videoUrl = await storageService.getUrl(videoFileName, { bucket: "renders" });
        const fileSize = await storageService.getFileSize(videoFileName, "renders");

        return {
          status: "completed",
          progress: 100,
          etaSeconds: 0,
          videoUrl,
          fileSize,
          storage: "supabase",
          publicBucket: false, // Will be set by storage service based on config
        };
      } catch (error) {
        // Continue to check local storage
        console.error("Failed to get Supabase URL:", error);
      }
    }

    // Check local storage
    if (await storageService.exists(videoFileName, "renders")) {
      try {
        const videoUrl = await storageService.getUrl(videoFileName, { bucket: "renders" });
        const fileSize = await storageService.getFileSize(videoFileName, "renders");

        return {
          status: "completed",
          progress: 100,
          etaSeconds: 0,
          videoUrl,
          fileSize,
          storage: "local",
        };
      } catch (error) {
        // Continue to check sandbox
        console.error("Failed to get local URL:", error);
      }
    }

    // Try to check sandbox progress
    try {
      const sandboxService = getSandboxService();
      const sandbox = await sandboxService.connect(renderId, { timeoutMs: 10_000 });

      // Check if output file exists
      const hasOutput = await sandboxService.fileExists(sandbox, "/tmp/output.mp4");
      if (hasOutput) {
        return {
          status: "completed",
          progress: 100,
          etaSeconds: 0,
        };
      }

      // Try to read progress file
      const progressText = await sandboxService.readProgress(sandbox);
      if (progressText) {
        const progress = parseJsonSafe<SandboxProgress>(progressText);

        if (progress && progress.status === "rendering") {
          const frameCount = progress.frameCount || 1;
          const framesDone = progress.framesDone || 0;
          const progressPercent = calculateProgress(framesDone, frameCount);
          const etaSeconds = calculateETA(progress);

          return {
            status: "rendering",
            progress: progressPercent,
            etaSeconds,
            frameCount,
            framesDone,
          };
        }

        if (progress && progress.status === "completed") {
          return {
            status: "completed",
            progress: 100,
            etaSeconds: 0,
          };
        }
      }
    } catch (error) {
      // Sandbox doesn't exist or can't be connected - assume rendering or return error
      console.error("Failed to check sandbox status:", error);
    }

    // Default: assume rendering
    return {
      status: "rendering",
      progress: 0,
    };
  }
}

// Singleton instance
let renderServiceInstance: RenderService | null = null;

/**
 * Get render service instance
 */
export function getRenderService(): RenderService {
  if (!renderServiceInstance) {
    renderServiceInstance = new RenderService();
  }
  return renderServiceInstance;
}
