import { inngest } from "../client"
import { createClient } from "@supabase/supabase-js"
import type { SupabaseClient } from "@supabase/supabase-js"
import { Sandbox } from "e2b"

const BLENDER_BIN = "/opt/blender-4.5.0-linux-x64/blender"
// Reduced frames per batch for faster processing and lower timeout risk
const FRAMES_PER_BATCH = parsePositiveInteger(process.env.RENDER_FRAMES_PER_BATCH, 2)
// Low resolution rendering for faster processing (640x480)
// Can be overridden via environment variables: RENDER_WIDTH, RENDER_HEIGHT
const DEFAULT_RENDER_WIDTH = parsePositiveInteger(process.env.RENDER_WIDTH, 640)
const DEFAULT_RENDER_HEIGHT = parsePositiveInteger(process.env.RENDER_HEIGHT, 480)

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseTimeout(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

// Increased default timeout for batch rendering (5 minutes)
// Complex renders can take longer, especially with multiple frames
const RENDER_BATCH_TIMEOUT_MS = parseTimeout(process.env.RENDER_BATCH_TIMEOUT_MS, 300_000)
const ENCODE_TIMEOUT_MS = parseTimeout(process.env.RENDER_ENCODE_TIMEOUT_MS, 300_000)

type SupabaseContext = {
  supabase: SupabaseClient<any, any, any>
  inputBucket: string
  outputBucket: string
}

type RenderBatchEventData = {
  id: string
  filename: string
  sandboxId: string
  tmpDir: string
  frameEnd: number
  batchStart: number
  batchEnd: number
  batchIndex: number
  framesPerBatch: number
  totalBatches: number
  outputBucket: string
}

type RenderFinalizeEventData = {
  id: string
  filename: string
  sandboxId: string
  tmpDir: string
  outputBucket: string
}

function createSupabaseContext(): SupabaseContext {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
  const inputBucket = process.env.SUPABASE_INPUT_BUCKET_NAME || "renders-input"
  const outputBucket = process.env.SUPABASE_OUTPUT_BUCKET_NAME || "render-output"

  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Supabase environment variables are not configured")
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  })

  return { supabase, inputBucket, outputBucket }
}

// Helper function to log errors with context
function logError(step: string, error: any, context?: Record<string, any>) {
  const errorMessage = error instanceof Error ? error.message : String(error)
  const errorDetails = {
    step,
    error: errorMessage,
    ...context,
    stack: error instanceof Error ? error.stack : undefined,
  }
  console.error(`[render-job] ERROR in ${step}:`, JSON.stringify(errorDetails, null, 2))
  return errorDetails
}

// Helper function to validate Blender file
function validateBlendFile(arrayBuffer: ArrayBuffer): { valid: boolean; error?: string } {
  try {
    if (arrayBuffer.byteLength === 0) {
      return { valid: false, error: "File is empty" }
    }

    // Check magic bytes for .blend files
    // Blender files start with "BLENDER" (7 bytes) followed by version info
    const header = new Uint8Array(arrayBuffer.slice(0, 12))
    const BLENDER_MAGIC = [0x42, 0x4c, 0x45, 0x4e, 0x44, 0x45, 0x52] // "BLENDER"

    // Check first 7 bytes match "BLENDER"
    for (let i = 0; i < BLENDER_MAGIC.length; i++) {
      if (header[i] !== BLENDER_MAGIC[i]) {
        return {
          valid: false,
          error: `Invalid Blender file: magic bytes mismatch at position ${i}. Expected "BLENDER" header.`,
        }
      }
    }

    // Check Blender version in file header (bytes 9-11)
    const blenderFileVersion = String.fromCharCode(...header.slice(9, 12))
    console.log(`[render-job] Blender file version detected: ${blenderFileVersion}`)

    // Current Blender in sandbox is 4.5.0 (version code "405")
    // If file version is newer, Blender 4.5.0 will fail to open it
    const fileVersionNum = parseInt(blenderFileVersion)
    if (fileVersionNum > 405) {
      console.warn(
        `[render-job] WARNING: Blender file version (${blenderFileVersion}) may be newer than sandbox Blender (4.5.0). This may cause errors.`,
      )
    }

    return { valid: true }
  } catch (err) {
    return {
      valid: false,
      error: `Failed to validate Blender file: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

type SetupResult = {
  sandboxId: string
  tmpDir: string
  frameStart: number
  frameEnd: number
  framesPerBatch: number
}

async function setupRenderJob({
  id,
  filename,
  supabase,
  inputBucket,
}: {
  id: string
  filename: string
  supabase: SupabaseClient<any, any, any>
  inputBucket: string
}): Promise<SetupResult> {
  console.log(`[render-job] Downloading input file (bucket: ${inputBucket}, path: ${id})`)

  let data: Blob | null = null
  let downloadError: any = null
  try {
    const result = await supabase.storage.from(inputBucket).download(id)
    data = result.data
    downloadError = result.error
  } catch (err) {
    downloadError = err
    logError("download", err, { bucket: inputBucket, path: id })
  }

  if (downloadError || !data) {
    const message = `Failed to download input file from Supabase (bucket=${inputBucket}, path=${id}): ${
      downloadError?.message ?? "no data returned"
    }`
    logError("download", downloadError || new Error("No data"), {
      bucket: inputBucket,
      path: id,
      error: downloadError,
    })
    throw new Error(message)
  }

  console.log(`[render-job] File downloaded successfully, size: ${data.size} bytes`)

  let blendArrayBuffer: ArrayBuffer
  try {
    blendArrayBuffer = await data.arrayBuffer()
  } catch (err) {
    logError("arraybuffer-conversion", err)
    throw new Error(`Failed to convert downloaded file to ArrayBuffer: ${err instanceof Error ? err.message : String(err)}`)
  }

  const validation = validateBlendFile(blendArrayBuffer)
  if (!validation.valid) {
    logError("file-validation", new Error(validation.error || "Unknown validation error"), {
      fileSize: blendArrayBuffer.byteLength,
    })
    throw new Error(`Invalid Blender file: ${validation.error}`)
  }

  let sandbox: Sandbox
  try {
    sandbox = await Sandbox.create("blender-renders")
    console.log(`[render-job] Sandbox created successfully: ${sandbox.sandboxId}`)
  } catch (err) {
    logError("sandbox-creation", err)
    throw new Error(`Failed to create E2B sandbox: ${err instanceof Error ? err.message : String(err)}`)
  }

  const cleanupOnError = async () => {
    try {
      await sandbox.kill()
    } catch (cleanupErr) {
      console.warn("[render-job] Failed to kill sandbox during cleanup:", cleanupErr)
    }
  }

  try {
    console.log("[render-job] Creating temporary directory in sandbox")
    const tmpResult = await sandbox.commands.run("mktemp -d /tmp/tenet-XXXXXX")
    const tmpDir = tmpResult.stdout.trim()
    if (!tmpDir || !tmpDir.startsWith("/tmp/")) {
      throw new Error(`Failed to create secure temp directory. Output: ${tmpResult.stdout}`)
    }

    const sceneFilePath = `${tmpDir}/scene.blend`
    console.log(`[render-job] Writing blend file to sandbox: ${sceneFilePath}`)
    try {
      await sandbox.files.write(sceneFilePath, blendArrayBuffer)
      console.log("[render-job] Blend file written successfully")
    } catch (err) {
      logError("file-write", err, { sceneFilePath })
      throw new Error(`Failed to write blend file to sandbox: ${err instanceof Error ? err.message : String(err)}`)
    }

    try {
      const fileInfo = await sandbox.commands.run(`stat -c%s "${sceneFilePath}"`)
      const fileSize = parseInt(fileInfo.stdout.trim())
      console.log(`[render-job] Verified file size: ${fileSize} bytes`)

      if (fileSize === 0) {
        throw new Error("Blend file is empty or failed to write correctly")
      }

      if (fileSize !== blendArrayBuffer.byteLength) {
        console.warn(
          `[render-job] WARNING: File size mismatch. Expected: ${blendArrayBuffer.byteLength}, Got: ${fileSize}`,
        )
      }
    } catch (err) {
      logError("file-verification", err)
      throw new Error(`Failed to verify blend file: ${err instanceof Error ? err.message : String(err)}`)
    }

    const framesDir = `${tmpDir}/frames`
    console.log(`[render-job] Creating frames directory: ${framesDir}`)
    try {
      await sandbox.commands.run(`mkdir -p "${framesDir}"`)
    } catch (err) {
      logError("frames-dir-creation", err, { framesDir })
      throw new Error(`Failed to create frames directory: ${err instanceof Error ? err.message : String(err)}`)
    }

    const getFrameRangeScript = `${tmpDir}/get_frames.py`
    const frameRangeScript = `import bpy
import json
import sys

try:
    s = bpy.context.scene
    frame_start = s.frame_start
    frame_end = s.frame_end
    print(json.dumps({"frame_start": frame_start, "frame_end": frame_end}))
    sys.exit(0)
except Exception as e:
    print(f"Error getting frame range: {e}", file=sys.stderr)
    sys.exit(1)
`

    try {
      await sandbox.files.write(getFrameRangeScript, frameRangeScript)
    } catch (err) {
      logError("frame-script-write", err)
      throw new Error(`Failed to write frame range script: ${err instanceof Error ? err.message : String(err)}`)
    }

    let frameRangeResult: any
    try {
      // Use xvfb-run for headless rendering to avoid EGL errors
      frameRangeResult = await sandbox.commands.run(
        `xvfb-run -s "-screen 0 ${DEFAULT_RENDER_WIDTH}x${DEFAULT_RENDER_HEIGHT}x24" ${BLENDER_BIN} -b "${sceneFilePath}" -P "${getFrameRangeScript}"`,
        { timeoutMs: RENDER_BATCH_TIMEOUT_MS },
      )
    } catch (err) {
      logError("frame-range-detection", err, {
        stdout: (err as any)?.stdout,
        stderr: (err as any)?.stderr,
      })
      throw new Error(
        `Failed to get frame range from Blender: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    if (frameRangeResult.stderr) {
      const stderrLower = frameRangeResult.stderr.toLowerCase()
      if (
        stderrLower.includes("error") ||
        stderrLower.includes("file format is not supported") ||
        stderrLower.includes("cannot open")
      ) {
        logError("blender-frame-range", new Error(frameRangeResult.stderr), {
          stdout: frameRangeResult.stdout,
          stderr: frameRangeResult.stderr,
        })
        throw new Error(
          `Blender cannot open the file. This usually means the file was created with a newer Blender version than 4.5.0. Error: ${frameRangeResult.stderr}`,
        )
      }
    }

    let frameStart = 1
    let frameEnd = 250
    try {
      const frameRangeMatch = frameRangeResult.stdout.match(/\{"frame_start":\s*(\d+),\s*"frame_end":\s*(\d+)\}/)
      if (frameRangeMatch) {
        frameStart = parseInt(frameRangeMatch[1])
        frameEnd = parseInt(frameRangeMatch[2])
      } else {
        console.warn(
          `[render-job] Could not parse frame range from output: ${frameRangeResult.stdout}. Using defaults.`,
        )
      }
    } catch (err) {
      console.warn("[render-job] Error parsing frame range, using defaults", err)
    }

    if (frameStart > frameEnd) {
      throw new Error(`Invalid frame range: start (${frameStart}) > end (${frameEnd})`)
    }

    console.log(`[render-job] Frame range detected: ${frameStart} to ${frameEnd} (${frameEnd - frameStart + 1} frames)`)

    return {
      sandboxId: sandbox.sandboxId,
      tmpDir,
      frameStart,
      frameEnd,
      framesPerBatch: Math.max(1, FRAMES_PER_BATCH),
    }
  } catch (err) {
    await cleanupOnError()
    throw err
  }
}

async function renderBatchStep({
  sandboxId,
  tmpDir,
  batchIndex,
  batchStart,
  batchEnd,
}: {
  sandboxId: string
  tmpDir: string
  batchIndex: number
  batchStart: number
  batchEnd: number
}) {
  console.log(`[render-job] Rendering batch ${batchIndex}: frames ${batchStart} to ${batchEnd}`)

  let sandbox: Sandbox
  try {
    sandbox = await Sandbox.connect(sandboxId)
    console.log(`[render-job] Reconnected to sandbox: ${sandboxId}`)
  } catch (err) {
    logError("sandbox-reconnect", err, { sandboxId, batchIndex })
    throw new Error(
      `Failed to reconnect to sandbox ${sandboxId} for batch ${batchIndex}. Sandbox may have timed out. Error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const sceneFilePath = `${tmpDir}/scene.blend`
  const framesDir = `${tmpDir}/frames`
  const renderScriptPath = `${tmpDir}/render_batch_${batchIndex}.py`

  const renderScript = `import bpy
import os
import sys

try:
    s = bpy.context.scene
    frames_dir = r'${framesDir}'
    s.render.filepath = os.path.join(frames_dir, 'frame_')
    
    # Set low resolution for faster rendering
    s.render.resolution_x = ${DEFAULT_RENDER_WIDTH}
    s.render.resolution_y = ${DEFAULT_RENDER_HEIGHT}
    s.render.resolution_percentage = 100
    
    start_frame = ${batchStart}
    end_frame = ${batchEnd}
    s.frame_start = start_frame
    s.frame_end = end_frame

    print(f"Rendering frames ${batchStart} to ${batchEnd} at {s.render.resolution_x}x{s.render.resolution_y}")
    bpy.ops.render.render(animation=True)
    print(f"Render complete: frames ${batchStart} to ${batchEnd}")
    sys.exit(0)
except Exception as e:
    print(f"Error during rendering: {e}", file=sys.stderr)
    sys.exit(1)
`

  try {
    await sandbox.files.write(renderScriptPath, renderScript)
  } catch (err) {
    logError("render-script-write", err, { renderScriptPath, batchIndex })
    throw new Error(`Failed to write render script: ${err instanceof Error ? err.message : String(err)}`)
  }

  try {
    // Use xvfb-run for headless rendering to avoid EGL errors
    // The virtual display size should match or exceed the render resolution
    const renderResult = await sandbox.commands.run(
      `xvfb-run -s "-screen 0 ${DEFAULT_RENDER_WIDTH}x${DEFAULT_RENDER_HEIGHT}x24" ${BLENDER_BIN} -b "${sceneFilePath}" -P "${renderScriptPath}"`,
      { timeoutMs: RENDER_BATCH_TIMEOUT_MS },
    )
    console.log(`[render-job] Batch ${batchIndex} render stdout:`, renderResult.stdout)
    if (renderResult.stderr) {
      console.log(`[render-job] Batch ${batchIndex} render stderr:`, renderResult.stderr)
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    const isTimeout = errorMessage.includes('timeout') || errorMessage.includes('Timeout') || errorMessage.includes('timed out')
    
    logError("blender-render", err, {
      batchIndex,
      frameRange: `${batchStart}-${batchEnd}`,
      stdout: (err as any)?.stdout,
      stderr: (err as any)?.stderr,
      exitCode: (err as any)?.exitCode,
      isTimeout,
    })
    
    if (isTimeout) {
      throw new Error(
        `Blender render timed out for batch ${batchIndex} (frames ${batchStart}-${batchEnd}) after ${RENDER_BATCH_TIMEOUT_MS / 1000} seconds. The render may be too complex. Consider reducing frames per batch or render resolution.`
      )
    }
    
    throw new Error(
      `Blender render failed for batch ${batchIndex} (frames ${batchStart}-${batchEnd}): ${errorMessage}. Exit code: ${(err as any)?.exitCode || "unknown"}. Stderr: ${(err as any)?.stderr || "none"}`,
    )
  }

  try {
    const checkFrames = await sandbox.commands.run(`ls -1 "${framesDir}" | wc -l`)
    const frameCount = parseInt(checkFrames.stdout.trim())
    console.log(`[render-job] Frame count after batch ${batchIndex}: ${frameCount}`)
    if (frameCount === 0 && batchIndex === 0) {
      throw new Error("No frames were rendered in the first batch. Check Blender output for errors.")
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("No frames were rendered")) {
      throw err
    }
    logError("frame-count-check", err, { batchIndex })
  }
}

async function encodeAndUploadStep({
  sandboxId,
  tmpDir,
  id,
  outputBucket,
  supabase,
}: {
  sandboxId: string
  tmpDir: string
  id: string
  outputBucket: string
  supabase: SupabaseClient<any, any, any>
}): Promise<string> {
  let sandbox: Sandbox
  try {
    sandbox = await Sandbox.connect(sandboxId)
    console.log(`[render-job] Reconnected to sandbox for encoding: ${sandboxId}`)
  } catch (err) {
    logError("sandbox-reconnect-encoding", err, { sandboxId })
    throw new Error(
      `Failed to reconnect to sandbox ${sandboxId} for encoding. Sandbox may have timed out. Error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const framesDir = `${tmpDir}/frames`
  const outputVideoPath = `${tmpDir}/output.mp4`

  let frameCount = 0
  try {
    const checkFrames = await sandbox.commands.run(`ls -1 "${framesDir}" | wc -l`)
    frameCount = parseInt(checkFrames.stdout.trim())
    console.log(`[render-job] Total frames to encode: ${frameCount}`)
  } catch (err) {
    logError("frame-verification", err)
    throw new Error(`Failed to verify frames: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (frameCount === 0) {
    throw new Error("No frames were rendered. Cannot encode video.")
  }

  try {
    const listFrames = await sandbox.commands.run(`ls -1 "${framesDir}" | head -5`)
    console.log("[render-job] Sample frame files:", listFrames.stdout)
  } catch (err) {
    console.warn("[render-job] Could not list sample frames:", err)
  }

  try {
    const ffmpegResult = await sandbox.commands.run(
      `ffmpeg -y -framerate 24 -i "${framesDir}/frame_%04d.png" -c:v libx264 -pix_fmt yuv420p -crf 23 "${outputVideoPath}"`,
      { timeoutMs: ENCODE_TIMEOUT_MS },
    )
    console.log("[render-job] FFmpeg stdout:", ffmpegResult.stdout)
    if (ffmpegResult.stderr) {
      console.log("[render-job] FFmpeg stderr:", ffmpegResult.stderr)
    }
  } catch (err) {
    logError("ffmpeg-encoding", err, {
      stdout: (err as any)?.stdout,
      stderr: (err as any)?.stderr,
      exitCode: (err as any)?.exitCode,
    })
    throw new Error(
      `FFmpeg encoding failed: ${err instanceof Error ? err.message : String(err)}. Exit code: ${(err as any)?.exitCode || "unknown"}. Stderr: ${(err as any)?.stderr || "none"}`,
    )
  }

  try {
    const verifyVideo = await sandbox.commands.run(`test -f "${outputVideoPath}" && echo "exists" || echo "missing"`)
    if (!verifyVideo.stdout.includes("exists")) {
      throw new Error("FFmpeg completed but output video file was not created.")
    }
  } catch (err) {
    logError("video-verification", err)
    throw new Error(`Failed to verify video file: ${err instanceof Error ? err.message : String(err)}`)
  }

  try {
    const videoSize = await sandbox.commands.run(`stat -c%s "${outputVideoPath}"`)
    console.log(`[render-job] Video file size: ${videoSize.stdout.trim()} bytes`)
  } catch (err) {
    console.warn("[render-job] Could not get video file size:", err)
  }

  let fileData: ArrayBuffer | Blob | string
  try {
    fileData = (await sandbox.files.read(outputVideoPath)) as unknown as ArrayBuffer | Blob | string
  } catch (err) {
    logError("video-read", err, { outputVideoPath })
    throw new Error(`Failed to read video file from sandbox: ${err instanceof Error ? err.message : String(err)}`)
  }

  const uploadPath = `jobs/${id}/output.mp4`
  let uploadResult: any
  try {
    uploadResult = await supabase.storage.from(outputBucket).upload(uploadPath, fileData, {
      contentType: "video/mp4",
      upsert: true,
    })
  } catch (err) {
    logError("supabase-upload", err, { bucket: outputBucket, path: uploadPath })
    throw new Error(`Failed to upload video to Supabase: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (uploadResult.error) {
    logError("supabase-upload-error", uploadResult.error, {
      bucket: outputBucket,
      path: uploadPath,
    })
    throw new Error(
      `Supabase upload failed (bucket=${outputBucket}, path=${uploadPath}): ${uploadResult.error.message}`,
    )
  }

  console.log(`[render-job] Video uploaded successfully: ${uploadResult.data?.path || uploadPath}`)

  return uploadResult.data?.path || uploadPath
}

async function cleanupSandboxById(sandboxId: string, tmpDir: string) {
  try {
    const sandbox = await Sandbox.connect(sandboxId)
    try {
      await sandbox.commands.run(`rm -rf -- "${tmpDir}"`)
    } catch (err) {
      console.warn(`[render-job] Failed to cleanup temp directory for sandbox ${sandboxId}:`, err)
    }

    try {
      await sandbox.kill()
      console.log(`[render-job] Sandbox ${sandboxId} cleaned up successfully`)
    } catch (err) {
      console.warn(`[render-job] Failed to kill sandbox ${sandboxId}:`, err)
    }
  } catch (err) {
    console.warn(`[render-job] Skipping cleanup for sandbox ${sandboxId}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export const renderJob = inngest.createFunction(
  { id: "render-job.start" },
  { event: "render/uploaded" },
  async ({ event, step }) => {
    const { id, filename } = event.data as { id: string; filename: string }

    console.log(`[render-job] Starting workflow for file: ${filename} (id: ${id})`)

    if (!id || !filename) {
      const error = "Missing required event data: id or filename"
      logError("event-validation", new Error(error), { id, filename })
      throw new Error(error)
    }

    if (!process.env.E2B_API_KEY) {
      const error = "E2B_API_KEY is not set in environment"
      logError("env-validation", new Error(error))
      throw new Error(error)
    }

    const { supabase, inputBucket, outputBucket } = createSupabaseContext()

    const setup = await step.run("setup-job", () =>
      setupRenderJob({ id, filename, supabase, inputBucket }),
    )

    const { sandboxId, tmpDir, frameStart, frameEnd, framesPerBatch } = setup
    const totalFrames = frameEnd - frameStart + 1

    if (totalFrames <= 0) {
      await cleanupSandboxById(sandboxId, tmpDir)
      return {
        ok: true,
        id,
        filename,
        totalFrames,
        totalBatches: 0,
      }
    }

    const totalBatches = Math.ceil(totalFrames / framesPerBatch)
    const firstBatchEnd = Math.min(frameStart + framesPerBatch - 1, frameEnd)

    await step.sendEvent("render-batch-0", {
      name: "render/process-batch",
      data: {
        id,
        filename,
        sandboxId,
        tmpDir,
        frameEnd,
        batchStart: frameStart,
        batchEnd: firstBatchEnd,
        batchIndex: 0,
        framesPerBatch,
        totalBatches,
        outputBucket,
      } satisfies RenderBatchEventData,
    })

    console.log(`[render-job] Setup complete. Dispatched first batch event. Total batches: ${totalBatches}`)

    return {
      ok: true,
      id,
      filename,
      sandboxId,
      tmpDir,
      frameStart,
      frameEnd,
      totalBatches,
      message: `Render job setup complete. Processing ${totalBatches} batches asynchronously. Check Inngest dashboard for progress.`,
    }
  },
)

export const processRenderBatch = inngest.createFunction(
  { id: "render-job.process-batch" },
  { event: "render/process-batch" },
  async ({ event, step }) => {
    const data = event.data as RenderBatchEventData
    const {
      id,
      filename,
      sandboxId,
      tmpDir,
      frameEnd,
      batchStart,
      batchEnd,
      batchIndex,
      framesPerBatch,
      totalBatches,
      outputBucket,
    } = data

    console.log(`[render-job] Processing batch ${batchIndex}/${totalBatches - 1}: frames ${batchStart}-${batchEnd}`)
    
    await step.run(`render-batch-${batchIndex}`, () =>
      renderBatchStep({ sandboxId, tmpDir, batchIndex, batchStart, batchEnd }),
    )

    console.log(`[render-job] Batch ${batchIndex} completed successfully`)

    const nextStart = batchEnd + 1
    if (nextStart <= frameEnd) {
      console.log(`[render-job] Dispatching next batch: ${batchIndex + 1}/${totalBatches - 1} (frames ${nextStart}-${Math.min(nextStart + framesPerBatch - 1, frameEnd)})`)
      const nextBatchEnd = Math.min(nextStart + framesPerBatch - 1, frameEnd)
      await step.sendEvent(`render-batch-${batchIndex + 1}`, {
        name: "render/process-batch",
        data: {
          id,
          filename,
          sandboxId,
          tmpDir,
          frameEnd,
          batchStart: nextStart,
          batchEnd: nextBatchEnd,
          batchIndex: batchIndex + 1,
          framesPerBatch,
          totalBatches,
          outputBucket,
        } satisfies RenderBatchEventData,
      })

      return {
        ok: true,
        id,
        batchIndex,
        dispatchedNextBatch: batchIndex + 1,
        remainingBatches: Math.max(totalBatches - (batchIndex + 1), 0),
      }
    }

    console.log(`[render-job] All batches completed. Dispatching finalize event.`)
    
    await step.sendEvent("render-finalize", {
      name: "render/finalize",
      data: {
        id,
        filename,
        sandboxId,
        tmpDir,
        outputBucket,
      } satisfies RenderFinalizeEventData,
    })

    return {
      ok: true,
      id,
      batchesCompleted: totalBatches,
      message: `All ${totalBatches} batches completed. Finalization in progress.`,
    }
  },
)

export const finalizeRenderJob = inngest.createFunction(
  { id: "render-job.finalize" },
  { event: "render/finalize" },
  async ({ event, step }) => {
    const data = event.data as RenderFinalizeEventData
    const { id, filename, sandboxId, tmpDir, outputBucket: eventOutputBucket } = data

    console.log(`[render-job] Finalizing render job for: ${filename} (id: ${id})`)

    const { supabase, outputBucket: envOutputBucket } = createSupabaseContext()
    const targetBucket = eventOutputBucket || envOutputBucket

    let outputVideoPath: string
    try {
      console.log(`[render-job] Starting encoding and upload step`)
      outputVideoPath = await step.run("encode-and-upload", () =>
        encodeAndUploadStep({
          sandboxId,
          tmpDir,
          id,
          outputBucket: targetBucket,
          supabase,
        }),
      )
      console.log(`[render-job] Encoding complete. Video uploaded to: ${outputVideoPath}`)
    } finally {
      console.log(`[render-job] Cleaning up sandbox: ${sandboxId}`)
      await cleanupSandboxById(sandboxId, tmpDir)
    }

    console.log(`[render-job] Render job finalized successfully for file: ${filename}`)

    return {
      ok: true,
      id,
      filename,
      outputBucket: targetBucket,
      outputPath: outputVideoPath,
      message: `Render job completed successfully. Video available at: ${outputVideoPath}`,
    }
  },
)

export const renderJobFunctions = [renderJob, processRenderBatch, finalizeRenderJob]
