/**
 * Blender-specific types - Frame extraction, progress, render results
 */

export interface BlendFrameData {
  frame_start?: number;
  frame_end?: number;
  frame_count?: number;
  fps?: number;
  error?: string;
  error_type?: string;
}

export interface BlenderRenderProgress {
  status: "rendering" | "completed" | "cancelled";
  frameStart: number;
  frameEnd: number;
  frameCount: number;
  currentFrame?: number;
  framesDone: number;
  startedAt: number;
  updatedAt: number;
}

export interface BlenderRenderResult {
  success: boolean;
  error?: string;
  error_type?: string;
  outputPath?: string;
}

export interface BlenderCommandOptions {
  timeoutSeconds?: number;
  factoryStartup?: boolean;
  disableAutoexec?: boolean;
  background?: boolean;
}

export type BlenderScript = "extract_frames" | "read_blend_header" | "render_mp4";
