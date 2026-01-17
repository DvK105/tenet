/**
 * Sandbox service - E2B sandbox lifecycle management
 */

import { Sandbox } from "e2b";
import { readFile } from "fs/promises";
import { appConfig } from "@/config/app.config";
import { blenderConfig } from "@/config/blender.config";
import { SandboxError } from "@/lib/errors/render-errors";
import { toBuffer, decodeSandboxText } from "@/lib/utils/sandbox-output.util";
import type { SandboxInstance, SandboxCommandResult, SandboxConnectionOptions, SandboxCreationOptions } from "@/types/sandbox.types";

/**
 * Sandbox service for E2B operations
 */
export class SandboxService {
  /**
   * Create a new sandbox
   */
  async create(options: SandboxCreationOptions = {}): Promise<SandboxInstance> {
    try {
      const template = options.template || appConfig.e2b.template || "blender-headless-template";
      const timeoutMs = options.timeoutMs || appConfig.e2b.defaultTimeoutMs;

      const sandbox = await Sandbox.create(template, {
        timeoutMs,
      });

      return sandbox;
    } catch (error) {
      throw SandboxError.fromConnection("new", error, { template: options.template || appConfig.e2b.template });
    }
  }

  /**
   * Connect to an existing sandbox
   */
  async connect(sandboxId: string, options: SandboxConnectionOptions = {}): Promise<SandboxInstance> {
    try {
      const timeoutMs = options.timeoutMs || 10_000; // Default 10 seconds for connection

      const sandbox = await Sandbox.connect(sandboxId, {
        timeoutMs,
      });

      return sandbox;
    } catch (error) {
      throw SandboxError.fromConnection(sandboxId, error);
    }
  }

  /**
   * Upload file to sandbox
   */
  async uploadFile(
    sandbox: SandboxInstance,
    sandboxPath: string,
    data: Buffer | ArrayBuffer | string | Uint8Array
  ): Promise<void> {
    try {
      const buffer = toBuffer(data);
      await sandbox.files.write(sandboxPath, buffer);
    } catch (error) {
      throw new SandboxError(
        `Failed to upload file to sandbox ${sandbox.sandboxId}: ${sandboxPath}`,
        sandbox.sandboxId,
        { filePath: sandboxPath, error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  /**
   * Read file from sandbox
   */
  async readFile(sandbox: SandboxInstance, sandboxPath: string): Promise<Buffer> {
    try {
      const data = await sandbox.files.read(sandboxPath);
      return toBuffer(data);
    } catch (error) {
      throw SandboxError.fromFileNotFound(sandbox.sandboxId, sandboxPath, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check if file exists in sandbox
   */
  async fileExists(sandbox: SandboxInstance, sandboxPath: string): Promise<boolean> {
    try {
      const files = await sandbox.files.list("/tmp");
      return files.some((file: { name: string }) => {
        const fileName = sandboxPath.split("/").pop();
        return file.name === fileName || sandboxPath.endsWith(file.name);
      });
    } catch {
      return false;
    }
  }

  /**
   * Upload Blender script to sandbox
   */
  async uploadScript(sandbox: SandboxInstance, scriptName: "extract_frames" | "read_blend_header" | "render_mp4"): Promise<string> {
    const scriptMap = {
      extract_frames: blenderConfig.scripts.extractFrames,
      read_blend_header: blenderConfig.scripts.readBlendHeader,
      render_mp4: blenderConfig.scripts.renderMp4,
    };

    const sandboxPathMap = {
      extract_frames: blenderConfig.sandbox.extractFramesScriptPath,
      read_blend_header: blenderConfig.sandbox.readBlendHeaderScriptPath,
      render_mp4: blenderConfig.sandbox.renderMp4ScriptPath,
    };

    const scriptPath = scriptMap[scriptName];
    const sandboxPath = sandboxPathMap[scriptName];

    try {
      const scriptContent = await readFile(scriptPath, "utf-8");
      await this.uploadFile(sandbox, sandboxPath, scriptContent);
      return sandboxPath;
    } catch (error) {
      throw new SandboxError(
        `Failed to upload script ${scriptName} to sandbox ${sandbox.sandboxId}`,
        sandbox.sandboxId,
        { scriptName, scriptPath, error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  /**
   * Execute command in sandbox
   */
  async executeCommand(
    sandbox: SandboxInstance,
    command: string,
    options: { timeoutMs?: number } = {}
  ): Promise<SandboxCommandResult> {
    try {
      const timeoutMs = options.timeoutMs ?? 0; // 0 = no timeout from E2B SDK
      const result = await sandbox.commands.run(command, { timeoutMs });

      return {
        exitCode: result.exitCode,
        stdout: result.stdout || "",
        stderr: result.stderr || "",
      };
    } catch (error: unknown) {
      // E2B SDK throws CommandExitError when exit code is non-zero
      if (
        typeof error === "object" &&
        error !== null &&
        "exitCode" in error &&
        ("stdout" in error || "stderr" in error)
      ) {
        return {
          exitCode: (error as { exitCode?: number }).exitCode,
          stdout: (error as { stdout?: string }).stdout || "",
          stderr: (error as { stderr?: string }).stderr || "",
        };
      }

      throw new SandboxError(
        `Command execution failed in sandbox ${sandbox.sandboxId}`,
        sandbox.sandboxId,
        { command, error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  /**
   * Kill sandbox (cleanup)
   */
  async kill(sandbox: SandboxInstance): Promise<void> {
    try {
      await sandbox.kill();
    } catch (error) {
      // Log but don't throw - cleanup errors shouldn't fail the operation
      console.error(`Failed to kill sandbox ${sandbox.sandboxId}:`, error);
    }
  }

  /**
   * Read progress file from sandbox
   */
  async readProgress(sandbox: SandboxInstance): Promise<string | null> {
    try {
      const buffer = await this.readFile(sandbox, blenderConfig.sandbox.progressJsonPath);
      return decodeSandboxText(buffer);
    } catch {
      return null;
    }
  }
}

// Singleton instance
let sandboxServiceInstance: SandboxService | null = null;

/**
 * Get sandbox service instance
 */
export function getSandboxService(): SandboxService {
  if (!sandboxServiceInstance) {
    sandboxServiceInstance = new SandboxService();
  }
  return sandboxServiceInstance;
}
