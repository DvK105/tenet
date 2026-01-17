/**
 * Custom error classes for render system
 */

export class RenderError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly context?: Record<string, unknown>
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class BlenderError extends RenderError {
  constructor(
    message: string,
    public readonly errorType?: string,
    context?: Record<string, unknown>
  ) {
    super(message, "BLENDER_ERROR", { ...context, errorType });
  }

  static fromSegmentationFault(context?: Record<string, unknown>): BlenderError {
    return new BlenderError(
      "Blender crashed with segmentation fault while processing the file.\n" +
        "Possible causes:\n" +
        "- Complex physics simulations (rigid body, cloth, etc.)\n" +
        "- Custom addons or scripts required by the file\n" +
        "- File format incompatibility\n" +
        "- Corrupted file data\n\n" +
        "Suggestion: Open the file in Blender GUI, simplify or remove problematic features, and re-export.",
      "SEGMENTATION_FAULT",
      context
    );
  }

  static fromTimeout(timeoutSeconds: number, context?: Record<string, unknown>): BlenderError {
    return new BlenderError(
      `Blender operation timed out after ${timeoutSeconds} seconds.\n` +
        `The file is taking too long to process. This usually means:\n` +
        `- The file is extremely complex with many objects/animations\n` +
        `- The file contains features that require extensive processing\n` +
        `- The file may be corrupted or have compatibility issues\n\n` +
        `Suggestions:\n` +
        `- Try opening the file in Blender GUI first to verify it loads\n` +
        `- Simplify the file by removing unnecessary objects or features\n` +
        `- Save the file in a newer Blender format if using an old version`,
      "TIMEOUT",
      { ...context, timeoutSeconds }
    );
  }

  static fromScriptError(error: string, errorType?: string, context?: Record<string, unknown>): BlenderError {
    return new BlenderError(
      `Blender script error: ${error}${errorType ? ` (error_type: ${errorType})` : ""}`,
      errorType || "SCRIPT_ERROR",
      context
    );
  }
}

export class SandboxError extends RenderError {
  constructor(
    message: string,
    public readonly sandboxId?: string,
    context?: Record<string, unknown>
  ) {
    super(message, "SANDBOX_ERROR", { ...context, sandboxId });
  }

  static fromConnection(sandboxId: string, error: unknown, context?: Record<string, unknown>): SandboxError {
    const message = error instanceof Error ? error.message : String(error);
    return new SandboxError(
      `Failed to connect to sandbox ${sandboxId}: ${message}`,
      sandboxId,
      { ...context, originalError: message }
    );
  }

  static fromFileNotFound(sandboxId: string, filePath: string, context?: Record<string, unknown>): SandboxError {
    return new SandboxError(
      `File not found in sandbox ${sandboxId}: ${filePath}`,
      sandboxId,
      { ...context, filePath }
    );
  }
}

export class StorageError extends RenderError {
  constructor(
    message: string,
    public readonly provider?: string,
    context?: Record<string, unknown>
  ) {
    super(message, "STORAGE_ERROR", { ...context, provider });
  }

  static fromUpload(provider: string, error: unknown, context?: Record<string, unknown>): StorageError {
    const message = error instanceof Error ? error.message : String(error);
    return new StorageError(
      `Failed to upload to ${provider}: ${message}`,
      provider,
      { ...context, originalError: message }
    );
  }

  static fromUrlGeneration(provider: string, error: unknown, context?: Record<string, unknown>): StorageError {
    const message = error instanceof Error ? error.message : String(error);
    return new StorageError(
      `Failed to generate URL from ${provider}: ${message}`,
      provider,
      { ...context, originalError: message }
    );
  }
}

export class RenderJobError extends RenderError {
  constructor(
    message: string,
    public readonly jobId: string,
    context?: Record<string, unknown>
  ) {
    super(message, "RENDER_JOB_ERROR", { ...context, jobId });
  }

  static fromStatus(jobId: string, error: unknown, context?: Record<string, unknown>): RenderJobError {
    const message = error instanceof Error ? error.message : String(error);
    return new RenderJobError(
      `Failed to check status for job ${jobId}: ${message}`,
      jobId,
      { ...context, originalError: message }
    );
  }
}
