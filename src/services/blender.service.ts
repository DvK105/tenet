/**
 * Blender service - Frame extraction, file validation, Blender command execution
 */

import { blenderConfig } from "@/config/blender.config";
import { BlenderError } from "@/lib/errors/render-errors";
import {
  parseFrameData,
  parseRenderResult,
  hasSegmentationFault,
  hasTimeout,
  extractExitCode,
} from "@/lib/errors/error-parser";
import { cleanExitCodeMarkers } from "@/lib/utils/json-parser.util";
import { getSandboxService } from "./sandbox.service";
import type { BlendFrameData, BlenderRenderResult, FrameData, BlenderCommandOptions } from "@/types";
import type { SandboxInstance, SandboxCommandResult } from "@/types/sandbox.types";

/**
 * Blender service for Blender operations
 */
export class BlenderService {
  /**
   * Extract frame data from Blender file using extract_frames.py script
   */
  async extractFrames(
    sandbox: SandboxInstance,
    blendFilePath: string = blenderConfig.sandbox.uploadedBlendPath
  ): Promise<FrameData> {
    const sandboxService = getSandboxService();

    // Upload extract_frames.py script
    const scriptPath = await sandboxService.uploadScript(sandbox, "extract_frames");

    // Also upload fallback header reader script
    try {
      await sandboxService.uploadScript(sandbox, "read_blend_header");
    } catch {
      // Fallback script is optional, continue without it
    }

    // Build Blender command
    const timeoutSeconds = blenderConfig.timeouts.frameExtraction;
    const command = this.buildBlenderCommand(scriptPath, blendFilePath, {
      timeoutSeconds,
      background: true,
      factoryStartup: true,
      disableAutoexec: true,
    });

    // Execute command
    let result: SandboxCommandResult;
    try {
      result = await sandboxService.executeCommand(sandbox, command, {
        timeoutMs: 0, // Use shell-level timeout
      });
    } catch (error) {
      // Handle command execution errors
      throw new BlenderError(
        `Failed to execute Blender frame extraction: ${error instanceof Error ? error.message : String(error)}`,
        "EXECUTION_ERROR",
        { blendFilePath }
      );
    }

    // Extract exit code
    const actualExitCode = extractExitCode((result.stderr || "") + (result.stdout || ""), result.exitCode);

    // Check for timeout
    const allOutput = (result.stderr || "") + (result.stdout || "");
    if (hasTimeout(allOutput, actualExitCode)) {
      // Try fallback method
      try {
        return await this.extractFramesFallback(sandbox, blendFilePath);
      } catch {
        // Fallback failed, throw timeout error
        throw BlenderError.fromTimeout(timeoutSeconds, { blendFilePath });
      }
    }

    // Check for segmentation fault
    if (hasSegmentationFault(allOutput) || actualExitCode === 139) {
      // Try fallback method
      try {
        return await this.extractFramesFallback(sandbox, blendFilePath);
      } catch {
        // Fallback failed, throw segfault error
        throw BlenderError.fromSegmentationFault({ blendFilePath });
      }
    }

    // Parse frame data from output
    const parseResult = parseFrameData(allOutput);
    if (!parseResult.data) {
      // Check if it was a timeout or segfault that we missed
      if (hasTimeout(allOutput, actualExitCode)) {
        throw BlenderError.fromTimeout(timeoutSeconds, { blendFilePath });
      }
      if (hasSegmentationFault(allOutput)) {
        throw BlenderError.fromSegmentationFault({ blendFilePath });
      }

      // Try fallback before giving up
      try {
        return await this.extractFramesFallback(sandbox, blendFilePath);
      } catch {
        throw new BlenderError(
          `No frame data found in Blender output. Exit code: ${actualExitCode}`,
          "PARSE_ERROR",
          { blendFilePath, output: allOutput.substring(0, 1000) }
        );
      }
    }

    const frameData = parseResult.data as BlendFrameData;

    // Check for errors in parsed data
    if (frameData.error) {
      throw BlenderError.fromScriptError(
        frameData.error,
        frameData.error_type || "UNKNOWN",
        { blendFilePath }
      );
    }

    // Validate frame data
    if (typeof frameData.frame_start !== "number" || typeof frameData.frame_end !== "number") {
      throw new BlenderError(
        `Invalid frame data: ${JSON.stringify(frameData)}`,
        "INVALID_DATA",
        { blendFilePath, frameData }
      );
    }

    // Convert to response format
    return {
      frameStart: frameData.frame_start,
      frameEnd: frameData.frame_end,
      frameCount: frameData.frame_count,
      fps: frameData.fps,
    };
  }

  /**
   * Fallback method: Read Blender file header directly without opening
   */
  private async extractFramesFallback(
    sandbox: SandboxInstance,
    blendFilePath: string
  ): Promise<FrameData> {
    const sandboxService = getSandboxService();

    // Upload fallback script if not already uploaded
    try {
      await sandboxService.uploadScript(sandbox, "read_blend_header");
    } catch {
      // Script might already be uploaded
    }

    const fallbackScriptPath = blenderConfig.sandbox.readBlendHeaderScriptPath;
    const command = `python3 ${fallbackScriptPath} ${blendFilePath} 2>&1`;

    const result = await sandboxService.executeCommand(sandbox, command, {
      timeoutMs: blenderConfig.timeouts.headerRead * 1000,
    });

    const output = (result.stderr || "") + (result.stdout || "");
    const parseResult = parseFrameData(output);

    if (!parseResult.data) {
      throw new BlenderError(
        "Fallback frame extraction failed: No data returned",
        "FALLBACK_ERROR",
        { blendFilePath, output: output.substring(0, 500) }
      );
    }

    const frameData = parseResult.data as BlendFrameData;

    if (typeof frameData.frame_start !== "number" || typeof frameData.frame_end !== "number") {
      throw new BlenderError(
        `Invalid fallback frame data: ${JSON.stringify(frameData)}`,
        "FALLBACK_INVALID_DATA",
        { blendFilePath }
      );
    }

    return {
      frameStart: frameData.frame_start,
      frameEnd: frameData.frame_end,
      frameCount: frameData.frame_count,
      fps: frameData.fps,
    };
  }

  /**
   * Build Blender command with proper flags
   */
  private buildBlenderCommand(
    scriptPath: string,
    blendFilePath: string,
    options: BlenderCommandOptions & { timeoutSeconds: number } = {}
  ): string {
    const {
      timeoutSeconds,
      background = blenderConfig.command.background,
      factoryStartup = blenderConfig.command.factoryStartup,
      disableAutoexec = blenderConfig.command.disableAutoexec,
    } = options;

    const flags: string[] = [];
    if (background) flags.push("--background");
    if (factoryStartup) flags.push("--factory-startup");
    if (disableAutoexec) flags.push("--disable-autoexec");

    // Capture exit code before || true masks it
    // Preserve stderr for JSON output, suppress stdout warnings
    return `(timeout ${timeoutSeconds} blender ${flags.join(" ")} --python ${scriptPath} -- ${blendFilePath} > /dev/null; EXIT=$?; echo "EXIT_CODE:$EXIT" >&2; exit $EXIT) 2>&1; true`;
  }

  /**
   * Parse render result from Blender output
   */
  parseRenderOutput(output: string): BlenderRenderResult {
    const cleaned = cleanExitCodeMarkers(output);
    const result = parseRenderResult(cleaned);

    if (!result.data) {
      return {
        success: false,
        error: "Failed to parse render output",
        error_type: "PARSE_ERROR",
      };
    }

    return result.data;
  }

  /**
   * Build render command
   */
  buildRenderCommand(
    scriptPath: string = blenderConfig.sandbox.renderMp4ScriptPath,
    blendFilePath: string = blenderConfig.sandbox.uploadedBlendPath,
    options: BlenderCommandOptions & { timeoutSeconds: number } = {}
  ): string {
    return this.buildBlenderCommand(scriptPath, blendFilePath, options);
  }
}

// Singleton instance
let blenderServiceInstance: BlenderService | null = null;

/**
 * Get Blender service instance
 */
export function getBlenderService(): BlenderService {
  if (!blenderServiceInstance) {
    blenderServiceInstance = new BlenderService();
  }
  return blenderServiceInstance;
}
