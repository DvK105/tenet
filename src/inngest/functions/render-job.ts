import { inngest } from "../client"
import { createClient } from "@supabase/supabase-js"
import { Sandbox } from "e2b"

const BLENDER_BIN = "/opt/blender-4.5.0-linux-x64/blender"
const FRAMES_PER_BATCH = 20 // Smaller batches = faster steps = less timeout risk
const CHECKPOINT_INTERVAL = "2m" // Checkpoint every 2 minutes

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

// Inngest function that orchestrates a render job when a file is uploaded.
// Flow:
// 1. Download the uploaded .blend file from Supabase storage
// 2. Validate the file
// 3. Create E2B sandbox and setup
// 4. Get frame range from Blender
// 5. Render frames in batches (creating checkpoints every 2 minutes)
// 6. Encode frames to MP4 with FFmpeg
// 7. Upload final video to Supabase
export const renderJob = inngest.createFunction(
  { id: "render-job" },
  { event: "render/uploaded" },
  async ({ event, step }) => {
    const { id, filename } = event.data as { id: string; filename: string }

    console.log(`[render-job] Starting render job for file: ${filename} (id: ${id})`)

    // Validate event data
    if (!id || !filename) {
      const error = "Missing required event data: id or filename"
      logError("event-validation", new Error(error), { id, filename })
      throw new Error(error)
    }

    // Get environment variables
    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
    const supabaseKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
    const inputBucket = process.env.SUPABASE_INPUT_BUCKET_NAME || "renders-input"
    const outputBucket =
      process.env.SUPABASE_OUTPUT_BUCKET_NAME || "render-output"

    if (!supabaseUrl || !supabaseKey) {
      const error = "Supabase environment variables are not configured"
      logError("env-validation", new Error(error), {
        hasUrl: !!supabaseUrl,
        hasKey: !!supabaseKey,
      })
      throw new Error(error)
    }

    if (!process.env.E2B_API_KEY) {
      const error = "E2B_API_KEY is not set in environment"
      logError("env-validation", new Error(error))
      throw new Error(error)
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
    })

    // Step 1: Download file, validate, and setup sandbox
    const { sandboxId, tmpDir, frameStart, frameEnd, framesPerBatch } = await step.run(
      "download-and-setup",
      async () => {
        console.log(`[render-job] Step 1: Downloading file from Supabase (bucket: ${inputBucket}, path: ${id})`)

        // Download file from Supabase
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
          const errorMessage = `Failed to download input file from Supabase (bucket=${inputBucket}, path=${id}): ${
            downloadError?.message ?? "no data returned"
          }`
          logError("download", downloadError || new Error("No data"), {
            bucket: inputBucket,
            path: id,
            error: downloadError,
          })
          throw new Error(errorMessage)
        }

        console.log(`[render-job] File downloaded successfully, size: ${data.size} bytes`)

        // Convert to ArrayBuffer for validation and writing
        let blendArrayBuffer: ArrayBuffer
        try {
          blendArrayBuffer = await data.arrayBuffer()
        } catch (err) {
          logError("arraybuffer-conversion", err)
          throw new Error(`Failed to convert downloaded file to ArrayBuffer: ${err instanceof Error ? err.message : String(err)}`)
        }

        // Validate Blender file
        console.log("[render-job] Validating Blender file format")
        const validation = validateBlendFile(blendArrayBuffer)
        if (!validation.valid) {
          logError("file-validation", new Error(validation.error || "Unknown validation error"), {
            fileSize: blendArrayBuffer.byteLength,
          })
          throw new Error(`Invalid Blender file: ${validation.error}`)
        }
        console.log("[render-job] File validation passed")

        // Create E2B sandbox
        console.log("[render-job] Creating E2B sandbox")
        let sandbox: Sandbox
        try {
          sandbox = await Sandbox.create("blender-renders")
          console.log(`[render-job] Sandbox created successfully: ${sandbox.sandboxId}`)
        } catch (err) {
          logError("sandbox-creation", err)
          throw new Error(`Failed to create E2B sandbox: ${err instanceof Error ? err.message : String(err)}`)
        }

        // Create temp directory in sandbox
        console.log("[render-job] Creating temporary directory in sandbox")
        let tmpDir: string
        try {
          const tmpResult = await sandbox.commands.run("mktemp -d /tmp/tenet-XXXXXX")
          tmpDir = tmpResult.stdout.trim()
          if (!tmpDir || !tmpDir.startsWith("/tmp/")) {
            await sandbox.kill()
            throw new Error(`Failed to create secure temp directory. Output: ${tmpResult.stdout}`)
          }
          console.log(`[render-job] Temporary directory created: ${tmpDir}`)
        } catch (err) {
          await sandbox.kill().catch(() => {})
          logError("temp-dir-creation", err)
          throw new Error(`Failed to create temp directory in sandbox: ${err instanceof Error ? err.message : String(err)}`)
        }

        // Write blend file to sandbox
        const sceneFilePath = `${tmpDir}/scene.blend`
        console.log(`[render-job] Writing blend file to sandbox: ${sceneFilePath}`)
        try {
          await sandbox.files.write(sceneFilePath, blendArrayBuffer)
          console.log("[render-job] Blend file written successfully")
        } catch (err) {
          await sandbox.kill().catch(() => {})
          logError("file-write", err, { sceneFilePath })
          throw new Error(`Failed to write blend file to sandbox: ${err instanceof Error ? err.message : String(err)}`)
        }

        // Verify file was written correctly
        try {
          const fileInfo = await sandbox.commands.run(`stat -c%s "${sceneFilePath}"`)
          const fileSize = parseInt(fileInfo.stdout.trim())
          console.log(`[render-job] Verified file size: ${fileSize} bytes`)

          if (fileSize === 0) {
            await sandbox.kill().catch(() => {})
            throw new Error("Blend file is empty or failed to write correctly")
          }

          if (fileSize !== blendArrayBuffer.byteLength) {
            console.warn(
              `[render-job] WARNING: File size mismatch. Expected: ${blendArrayBuffer.byteLength}, Got: ${fileSize}`,
            )
          }
        } catch (err) {
          await sandbox.kill().catch(() => {})
          logError("file-verification", err)
          throw new Error(`Failed to verify blend file: ${err instanceof Error ? err.message : String(err)}`)
        }

        // Create frames directory
        const framesDir = `${tmpDir}/frames`
        console.log(`[render-job] Creating frames directory: ${framesDir}`)
        try {
          await sandbox.commands.run(`mkdir -p "${framesDir}"`)
        } catch (err) {
          await sandbox.kill().catch(() => {})
          logError("frames-dir-creation", err, { framesDir })
          throw new Error(`Failed to create frames directory: ${err instanceof Error ? err.message : String(err)}`)
        }

        // Get frame range from Blender
        console.log("[render-job] Getting frame range from Blender")
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
          await sandbox.kill().catch(() => {})
          logError("frame-script-write", err)
          throw new Error(`Failed to write frame range script: ${err instanceof Error ? err.message : String(err)}`)
        }

        // Run Blender to get frame range
        let frameRangeResult: any
        try {
          frameRangeResult = await sandbox.commands.run(
            `${BLENDER_BIN} -b "${sceneFilePath}" -P "${getFrameRangeScript}" --background`,
            { timeoutMs: 300000 }, // 5 minutes timeout
          )
        } catch (err) {
          await sandbox.kill().catch(() => {})
          logError("frame-range-detection", err, {
            stdout: (err as any)?.stdout,
            stderr: (err as any)?.stderr,
          })
          throw new Error(
            `Failed to get frame range from Blender: ${err instanceof Error ? err.message : String(err)}`,
          )
        }

        // Check for Blender errors
        if (frameRangeResult.stderr) {
          const stderrLower = frameRangeResult.stderr.toLowerCase()
          if (
            stderrLower.includes("error") ||
            stderrLower.includes("file format is not supported") ||
            stderrLower.includes("cannot open")
          ) {
            await sandbox.kill().catch(() => {})
            logError("blender-frame-range", new Error(frameRangeResult.stderr), {
              stdout: frameRangeResult.stdout,
              stderr: frameRangeResult.stderr,
            })
            throw new Error(
              `Blender cannot open the file. This usually means the file was created with a newer Blender version than 4.5.0. Error: ${frameRangeResult.stderr}`,
            )
          }
        }

        // Parse frame range
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
          await sandbox.kill().catch(() => {})
          throw new Error(`Invalid frame range: start (${frameStart}) > end (${frameEnd})`)
        }

        console.log(`[render-job] Frame range detected: ${frameStart} to ${frameEnd} (${frameEnd - frameStart + 1} frames)`)

        // Don't kill sandbox - we'll reconnect to it in next steps
        return {
          sandboxId: sandbox.sandboxId,
          tmpDir,
          frameStart,
          frameEnd,
          framesPerBatch: FRAMES_PER_BATCH,
        }
      },
    )

    // Step 2+: Render frames in batches with checkpoints
    console.log(
      `[render-job] Step 2+: Starting batch rendering. Total frames: ${frameEnd - frameStart + 1}, Batch size: ${framesPerBatch}`,
    )

    let currentFrame = frameStart - 1 // Start from before first frame
    let stepCount = 0 // Start from 0 for first batch

    while (currentFrame < frameEnd) {
      const nextBatchEnd = Math.min(currentFrame + framesPerBatch, frameEnd)
      const batchStart = currentFrame + 1

      console.log(`[render-job] Rendering batch ${stepCount}: frames ${batchStart} to ${nextBatchEnd}`)

      await step.run(`render-batch-${stepCount}`, async () => {
        // Reconnect to existing sandbox
        let sandbox: Sandbox
        try {
          sandbox = await Sandbox.connect(sandboxId)
          console.log(`[render-job] Reconnected to sandbox: ${sandboxId}`)
        } catch (err) {
          logError("sandbox-reconnect", err, { sandboxId, batch: stepCount })
          throw new Error(
            `Failed to reconnect to sandbox ${sandboxId} for batch ${stepCount}. Sandbox may have timed out. Error: ${err instanceof Error ? err.message : String(err)}`,
          )
        }

        try {
          const sceneFilePath = `${tmpDir}/scene.blend`
          const framesDir = `${tmpDir}/frames`
          const renderScriptPath = `${tmpDir}/render_batch_${stepCount}.py`

          // Create render script
          const renderScript = `import bpy
import os
import sys

try:
    s = bpy.context.scene
    frames_dir = r'${framesDir}'
    s.render.filepath = os.path.join(frames_dir, 'frame_')

    start_frame = ${batchStart}
    end_frame = ${nextBatchEnd}
    s.frame_start = start_frame
    s.frame_end = end_frame

    print(f"Rendering frames {start_frame} to {end_frame}")
    bpy.ops.render.render(animation=True)
    print(f"Render complete: frames {start_frame} to {end_frame}")
    sys.exit(0)
except Exception as e:
    print(f"Error during rendering: {e}", file=sys.stderr)
    sys.exit(1)
`

          try {
            await sandbox.files.write(renderScriptPath, renderScript)
          } catch (err) {
            logError("render-script-write", err, { renderScriptPath })
            throw new Error(`Failed to write render script: ${err instanceof Error ? err.message : String(err)}`)
          }

          // Run Blender render
          const fullBlenderCmd = `${BLENDER_BIN} -b "${sceneFilePath}" -P "${renderScriptPath}"`

          console.log(`[render-job] Executing Blender render command for batch ${stepCount}`)
          let renderResult: any
          try {
            renderResult = await sandbox.commands.run(fullBlenderCmd, { timeoutMs: 0 }) // No timeout for rendering
          } catch (err) {
            logError("blender-render", err, {
              batch: stepCount,
              frameRange: `${batchStart}-${nextBatchEnd}`,
              stdout: (err as any)?.stdout,
              stderr: (err as any)?.stderr,
              exitCode: (err as any)?.exitCode,
            })
            throw new Error(
              `Blender render failed for batch ${stepCount} (frames ${batchStart}-${nextBatchEnd}): ${err instanceof Error ? err.message : String(err)}. Exit code: ${(err as any)?.exitCode || "unknown"}. Stderr: ${(err as any)?.stderr || "none"}`,
            )
          }

          console.log(`[render-job] Batch ${stepCount} render stdout:`, renderResult.stdout)
          if (renderResult.stderr) {
            console.log(`[render-job] Batch ${stepCount} render stderr:`, renderResult.stderr)
          }

          // Check if render produced frames
          try {
            const checkFrames = await sandbox.commands.run(`ls -1 "${framesDir}" | wc -l`)
            const frameCount = parseInt(checkFrames.stdout.trim())
            console.log(`[render-job] Total frames rendered after batch ${stepCount}: ${frameCount}`)

            if (frameCount === 0 && stepCount === 0) {
              // First batch produced no frames - this is an error
              throw new Error(
                `No frames were rendered in the first batch. Check Blender output for errors. Stdout: ${renderResult.stdout}, Stderr: ${renderResult.stderr}`,
              )
            }
          } catch (err) {
            if (err instanceof Error && err.message.includes("No frames were rendered")) {
              throw err
            }
            logError("frame-count-check", err)
            // Don't throw - frame count check is not critical
          }
        } catch (err) {
          // Log error but don't kill sandbox - we might be able to continue
          logError(`render-batch-${stepCount}`, err, {
            batch: stepCount,
            frameRange: `${batchStart}-${nextBatchEnd}`,
          })
          throw err // Re-throw to fail the step
        }
      })

      currentFrame = nextBatchEnd
      stepCount++
    }

    console.log(`[render-job] All batches rendered. Total batches: ${stepCount}`)

    // Final step: Encode frames to MP4 and upload
    const outputVideoPath = await step.run("encode-and-upload", async () => {
      console.log("[render-job] Final step: Encoding and uploading video")

      // Reconnect to sandbox
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

      try {
        const framesDir = `${tmpDir}/frames`
        const outputVideoPath = `${tmpDir}/output.mp4`

        // Verify frames exist
        console.log("[render-job] Verifying rendered frames exist")
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

        // List sample frames for debugging
        try {
          const listFrames = await sandbox.commands.run(`ls -1 "${framesDir}" | head -5`)
          console.log("[render-job] Sample frame files:", listFrames.stdout)
        } catch (err) {
          console.warn("[render-job] Could not list sample frames:", err)
        }

        // Encode with FFmpeg
        const ffmpegCmd = `ffmpeg -y -framerate 24 -i "${framesDir}/frame_%04d.png" -c:v libx264 -pix_fmt yuv420p -crf 23 "${outputVideoPath}"`

        console.log("[render-job] Executing FFmpeg encoding command")
        let ffmpegResult: any
        try {
          ffmpegResult = await sandbox.commands.run(ffmpegCmd, { timeoutMs: 0 }) // No timeout for encoding
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

        console.log("[render-job] FFmpeg stdout:", ffmpegResult.stdout)
        if (ffmpegResult.stderr) {
          console.log("[render-job] FFmpeg stderr:", ffmpegResult.stderr)
        }

        // Verify video was created
        console.log("[render-job] Verifying video file was created")
        try {
          const verifyVideo = await sandbox.commands.run(
            `test -f "${outputVideoPath}" && echo "exists" || echo "missing"`,
          )
          if (!verifyVideo.stdout.includes("exists")) {
            throw new Error(
              `FFmpeg completed but output video file was not created. FFmpeg stdout: ${ffmpegResult.stdout}, stderr: ${ffmpegResult.stderr}`,
            )
          }
        } catch (err) {
          logError("video-verification", err)
          throw new Error(`Failed to verify video file: ${err instanceof Error ? err.message : String(err)}`)
        }

        // Get video file size
        try {
          const videoSize = await sandbox.commands.run(`stat -c%s "${outputVideoPath}"`)
          console.log(`[render-job] Video file size: ${videoSize.stdout.trim()} bytes`)
        } catch (err) {
          console.warn("[render-job] Could not get video file size:", err)
        }

        // Read video file from sandbox
        console.log("[render-job] Reading video file from sandbox")
        let fileData: ArrayBuffer | Blob | string
        try {
          fileData = (await sandbox.files.read(outputVideoPath)) as unknown as
            | ArrayBuffer
            | Blob
            | string
        } catch (err) {
          logError("video-read", err, { outputVideoPath })
          throw new Error(`Failed to read video file from sandbox: ${err instanceof Error ? err.message : String(err)}`)
        }

        // Upload to Supabase
        const uploadPath = `jobs/${id}/output.mp4`
        console.log(`[render-job] Uploading video to Supabase (bucket: ${outputBucket}, path: ${uploadPath})`)
        let uploadResult: any
        try {
          uploadResult = await supabase.storage.from(outputBucket).upload(uploadPath, fileData, {
            contentType: "video/mp4",
            upsert: true,
          })
        } catch (err) {
          logError("supabase-upload", err, { bucket: outputBucket, path: uploadPath })
          throw new Error(
            `Failed to upload video to Supabase: ${err instanceof Error ? err.message : String(err)}`,
          )
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
      } finally {
        // Cleanup sandbox
        console.log("[render-job] Cleaning up sandbox")
        try {
          await sandbox.commands.run(`rm -rf -- "${tmpDir}"`).catch(() => {
            console.warn("[render-job] Failed to cleanup temp directory")
          })
        } catch (err) {
          console.warn("[render-job] Error during temp directory cleanup:", err)
        }

        try {
          await sandbox.kill()
          console.log("[render-job] Sandbox killed successfully")
        } catch (err) {
          console.warn("[render-job] Error killing sandbox:", err)
        }
      }
    })

    console.log(`[render-job] Render job completed successfully for file: ${filename}`)

    return {
      ok: true,
      id,
      filename,
      outputBucket,
      outputPath: outputVideoPath,
    }
  },
)
