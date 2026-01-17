/**
 * Blender-specific configuration - Timeouts, paths, command templates
 */

import { join } from "path";

/**
 * Blender configuration
 */
export const blenderConfig = {
  // Timeouts in seconds
  timeouts: {
    frameExtraction: 120, // 2 minutes for frame extraction
    render: 36000, // 10 hours for rendering
    headerRead: 5, // 5 seconds for header read fallback
  },

  // Script paths (relative to project root)
  scripts: {
    extractFrames: join(process.cwd(), "e2b-template", "extract_frames.py"),
    readBlendHeader: join(process.cwd(), "e2b-template", "read_blend_header.py"),
    renderMp4: join(process.cwd(), "e2b-template", "render_mp4.py"),
  },

  // Sandbox paths
  sandbox: {
    uploadedBlendPath: "/tmp/uploaded.blend",
    outputMp4Path: "/tmp/output.mp4",
    progressJsonPath: "/tmp/render_progress.json",
    extractFramesScriptPath: "/tmp/extract_frames.py",
    readBlendHeaderScriptPath: "/tmp/read_blend_header.py",
    renderMp4ScriptPath: "/tmp/render_mp4.py",
  },

  // Blender command options
  command: {
    factoryStartup: true,
    disableAutoexec: true,
    background: true,
  },

  // Environment variables for render script
  env: {
    outputPath: "TENET_OUTPUT_PATH",
    progressPath: "TENET_PROGRESS_PATH",
    frameStart: "TENET_FRAME_START",
    frameEnd: "TENET_FRAME_END",
    enableCyclesGpu: "TENET_ENABLE_CYCLES_GPU",
  },

  // Local storage paths
  local: {
    rendersDirectory: join(process.cwd(), "public", "renders"),
  },
} as const;
