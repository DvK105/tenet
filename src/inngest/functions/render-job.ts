import { inngest } from "../client"
import { createClient } from "@supabase/supabase-js"
import { Sandbox } from "e2b"

const BLENDER_BIN = "/opt/blender-4.5.0-linux-x64/blender"

// Inngest function that will orchestrate a render job when a file is uploaded.
// Flow:
// 1. Download the uploaded .blend file from Supabase storage
// 2. Start rendering immediately in frame batches
// 3. Every 4 minutes, create a new step to continue rendering (avoiding timeouts)
// 4. Once all frames are rendered, encode with ffmpeg and upload
export const renderJob = inngest.createFunction(
  { id: "render-job" },
  { event: "render/uploaded" },
  async ({ event, step }) => {
    const { id, filename } = event.data as { id: string; filename: string }

    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
    const supabaseKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
    const inputBucket = process.env.SUPABASE_INPUT_BUCKET_NAME || "renders-input"
    const outputBucket =
      process.env.SUPABASE_OUTPUT_BUCKET_NAME || "render-output"

    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Supabase environment variables are not configured")
    }

    if (!process.env.E2B_API_KEY) {
      throw new Error("E2B_API_KEY is not set in environment")
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
    })

    // Step 1: Download file, setup sandbox, get frame range, and render first batch
    const { sandboxId, tmpDir, frameStart, frameEnd, framesPerBatch } = await step.run(
      "download-and-start-render",
      async () => {
        // Download file
        const { data, error } = await supabase.storage
          .from(inputBucket)
          .download(id)

        if (error || !data) {
          throw new Error(
            `Failed to download input file from Supabase (bucket=${inputBucket}, path=${id}): ${
              error?.message ?? "no data"
            }`,
          )
        }

        const blendArrayBuffer = await data.arrayBuffer()

        // Create sandbox immediately
        const sandbox = await Sandbox.create("blender-renders")
        console.log("[render-job] sandbox created", { sandboxId: sandbox.sandboxId })

        // Create temp directory
        const tmpResult = await sandbox.commands.run(
          "mktemp -d /tmp/tenet-XXXXXX",
        )
        const dir = tmpResult.stdout.trim()
        if (!dir || !dir.startsWith("/tmp/")) {
          await sandbox.kill()
          throw new Error("Failed to create secure temp directory in sandbox")
        }

        // Write blend file
        const sceneFilePath = `${dir}/scene.blend`
        await sandbox.files.write(sceneFilePath, blendArrayBuffer as ArrayBuffer)
        console.log("[render-job] wrote blend file to sandbox", { sceneFilePath })

        // Verify file was written and check file size
        const fileInfo = await sandbox.commands.run(`stat -c%s "${sceneFilePath}"`)
        const fileSize = parseInt(fileInfo.stdout.trim())
        console.log("[render-job] Blend file size:", fileSize, "bytes")

        if (fileSize === 0) {
          await sandbox.kill()
          throw new Error("Blend file is empty or failed to write")
        }

        // Check if file is a valid blend file (should start with "BLENDER")
        const fileHeader = await sandbox.commands.run(`head -c 7 "${sceneFilePath}"`)
        if (!fileHeader.stdout.includes("BLENDER")) {
          console.warn("[render-job] File header check:", fileHeader.stdout)
          // Not necessarily an error - could be compressed
        }

        // Create frames directory
        const framesDir = `${dir}/frames`
        await sandbox.commands.run(`mkdir -p "${framesDir}"`)

        // Get frame range from Blender
        // Note: Blender already loads the file with -b flag, so we don't need to open it again
        const getFrameRangeScript = `${dir}/get_frames.py`
        const frameRangeScript = `import bpy
import json
import sys

# File is already loaded by Blender -b flag
try:
    s = bpy.context.scene
    frame_start = s.frame_start
    frame_end = s.frame_end
    print(json.dumps({"frame_start": frame_start, "frame_end": frame_end}))
except Exception as e:
    print(f"Error getting frame range: {e}", file=sys.stderr)
    sys.exit(1)
`
        await sandbox.files.write(getFrameRangeScript, frameRangeScript)
        
        console.log("[render-job] Getting frame range from Blender")
        // Use a reasonable timeout for frame range detection (5 minutes should be enough)
        const frameRangeResult = await sandbox.commands.run(
          `${BLENDER_BIN} -b "${sceneFilePath}" -P "${getFrameRangeScript}" --background`,
          { timeoutMs: 300000 } // 5 minutes
        )
        
        // Check for errors in stderr
        if (frameRangeResult.stderr && frameRangeResult.stderr.includes("Error") || 
            frameRangeResult.stderr && frameRangeResult.stderr.includes("File format is not supported")) {
          console.error("[render-job] Blender error getting frame range:", frameRangeResult.stderr)
          throw new Error(
            `Blender cannot open the file. This usually means the file was created with a newer Blender version than 4.5.0. Error: ${frameRangeResult.stderr}`
          )
        }
        
        let frameStart = 1
        let frameEnd = 250
        try {
          const frameRangeMatch = frameRangeResult.stdout.match(/\{"frame_start":\s*(\d+),\s*"frame_end":\s*(\d+)\}/)
          if (frameRangeMatch) {
            frameStart = parseInt(frameRangeMatch[1])
            frameEnd = parseInt(frameRangeMatch[2])
          }
        } catch (e) {
          console.warn("[render-job] Could not parse frame range, using defaults", e)
        }

        console.log("[render-job] Frame range:", { frameStart, frameEnd })

        // Render first batch immediately (50 frames per batch)
        const framesPerBatch = 50
        const firstBatchEnd = Math.min(frameStart + framesPerBatch - 1, frameEnd)
        
        const renderScriptPath = `${dir}/render_batch_0.py`
        const renderScript = `import bpy
import os

# File is already loaded by Blender -b flag
s = bpy.context.scene
frames_dir = r'${framesDir}'
s.render.filepath = os.path.join(frames_dir, 'frame_')

start_frame = ${frameStart}
end_frame = ${firstBatchEnd}
s.frame_start = start_frame
s.frame_end = end_frame

print(f"Rendering frames {start_frame} to {end_frame}")
bpy.ops.render.render(animation=True)
print(f"Render complete: frames {start_frame} to {end_frame}")
`
        await sandbox.files.write(renderScriptPath, renderScript)

        // Render first batch and wait for completion
        // Disable timeout for long renders (0 = no timeout)
        const fullBlenderCmd = `xvfb-run -s "-screen 0 1920x1080x24" ${BLENDER_BIN} -b "${sceneFilePath}" -P "${renderScriptPath}"`
        console.log("[render-job] Starting first batch render: frames", frameStart, "to", firstBatchEnd)
        
        const renderResult = await sandbox.commands.run(fullBlenderCmd, { timeoutMs: 0 })
        console.log("[render-job] First batch complete:", renderResult.stdout)

        // Check frame count
        const checkFrames = await sandbox.commands.run(`ls -1 "${framesDir}" | wc -l`)
        const frameCount = parseInt(checkFrames.stdout.trim())
        console.log("[render-job] Frames rendered so far:", frameCount)

        // Don't kill sandbox - we'll reconnect to it in next steps
        // Note: E2B sandboxes may timeout after inactivity, but we'll try to reconnect

        return {
          sandboxId: sandbox.sandboxId,
          tmpDir: dir,
          frameStart,
          frameEnd,
          framesPerBatch,
        }
      },
    )

    // Step 2+: Continue rendering in batches, creating new steps every 4 minutes
    let currentFrame = frameStart + framesPerBatch - 1
    let stepCount = 1

    while (currentFrame < frameEnd) {
      // Sleep for 4 minutes to create a checkpoint and avoid timeout
      await step.sleep(`checkpoint-${stepCount}`, "4m")
      
      const nextBatchEnd = Math.min(currentFrame + framesPerBatch, frameEnd)
      const batchStart = currentFrame + 1
      
      await step.run(`render-batch-${stepCount}`, async () => {
        // Try to reconnect to existing sandbox, or create new one if it timed out
        let sandbox: Sandbox
        try {
          sandbox = await Sandbox.connect(sandboxId)
          console.log("[render-job] Reconnected to sandbox", { sandboxId })
        } catch (err) {
          console.warn("[render-job] Could not reconnect to sandbox, creating new one", err)
          // If reconnection fails, we'd need to re-download and setup, but for now just throw
          throw new Error(`Failed to reconnect to sandbox ${sandboxId}. Sandbox may have timed out.`)
        }
        
        try {
          const sceneFilePath = `${tmpDir}/scene.blend`
          const framesDir = `${tmpDir}/frames`
          const renderScriptPath = `${tmpDir}/render_batch_${stepCount}.py`
          
          const renderScript = `import bpy
import os

# File is already loaded by Blender -b flag
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
`
          await sandbox.files.write(renderScriptPath, renderScript)

          const fullBlenderCmd = `xvfb-run -s "-screen 0 1920x1080x24" ${BLENDER_BIN} -b "${sceneFilePath}" -P "${renderScriptPath}"`
          
          console.log(`[render-job] Rendering batch ${stepCount}: frames ${batchStart} to ${nextBatchEnd}`)
          // Disable timeout for long renders (0 = no timeout)
          const renderResult = await sandbox.commands.run(fullBlenderCmd, { timeoutMs: 0 })
          console.log(`[render-job] Batch ${stepCount} complete:`, renderResult.stdout)
          
          // Check frame count
          const checkFrames = await sandbox.commands.run(`ls -1 "${framesDir}" | wc -l`)
          const frameCount = parseInt(checkFrames.stdout.trim())
          console.log(`[render-job] Total frames rendered: ${frameCount}`)
          
        } finally {
          // Don't kill sandbox - we need it for next batch or final step
          // The sandbox will be cleaned up in the final step
        }
      })

      currentFrame = nextBatchEnd
      stepCount++
    }

    // Final step: Encode and upload
    const videoPath = await step.run("encode-and-upload", async () => {
      // Reconnect to sandbox
      let sandbox: Sandbox
      try {
        sandbox = await Sandbox.connect(sandboxId)
        console.log("[render-job] Reconnected to sandbox for encoding", { sandboxId })
      } catch (err) {
        throw new Error(`Failed to reconnect to sandbox ${sandboxId} for encoding. Sandbox may have timed out.`)
      }

      try {
        const framesDir = `${tmpDir}/frames`
        const outputVideoPath = `${tmpDir}/output.mp4`
        
        // Check frame files before encoding
        const listFrames = await sandbox.commands.run(`ls -1 "${framesDir}" | head -5`)
        console.log("[render-job] sample frame files:", listFrames.stdout)
        
        // Verify we have frames
        const checkFrames = await sandbox.commands.run(`ls -1 "${framesDir}" | wc -l`)
        const frameCount = parseInt(checkFrames.stdout.trim())
        console.log("[render-job] Total frames to encode:", frameCount)
        
        if (frameCount === 0) {
          throw new Error("No frames were rendered. Cannot encode video.")
        }
        
        const ffmpegCmd =
          `ffmpeg -y -framerate 24 -i "${framesDir}/frame_%04d.png" -c:v libx264 -pix_fmt yuv420p -crf 23 "${outputVideoPath}"`

        console.log("[render-job] executing ffmpeg command")
        // Disable timeout for video encoding (0 = no timeout)
        const ffmpegResult = await sandbox.commands.run(ffmpegCmd, { timeoutMs: 0 })
        console.log("[render-job] ffmpeg stdout:", ffmpegResult.stdout)
        console.log("[render-job] ffmpeg stderr:", ffmpegResult.stderr)
        
        // Verify video was created
        const verifyVideo = await sandbox.commands.run(`test -f "${outputVideoPath}" && echo "exists" || echo "missing"`)
        if (!verifyVideo.stdout.includes("exists")) {
          throw new Error("FFmpeg completed but output video file was not created")
        }
        
        const videoSize = await sandbox.commands.run(`stat -c%s "${outputVideoPath}"`)
        console.log("[render-job] video file size:", videoSize.stdout.trim(), "bytes")

        // Read the MP4 from the sandbox
        const fileData = (await sandbox.files.read(outputVideoPath)) as unknown as
          | ArrayBuffer
          | Blob
          | string

        // Upload to render-output bucket
        const { data, error } = await supabase.storage
          .from(outputBucket)
          .upload(`jobs/${id}/output.mp4`, fileData, {
            contentType: "video/mp4",
            upsert: true,
          })

        if (error) {
          throw new Error(
            `Failed to upload output video to Supabase (bucket=${outputBucket}, job=${id}): ${error.message}`,
          )
        }

        return data?.path ?? `jobs/${id}/output.mp4`
      } finally {
        // Cleanup
        try {
          await sandbox.commands.run(`rm -rf -- "${tmpDir}"`)
        } catch {
          // ignore cleanup errors
        }
        try {
          await sandbox.kill()
        } catch {
          // ignore
        }
      }
    })

    return {
      ok: true,
      id,
      filename,
      outputBucket,
      outputPath: videoPath,
    }
  },
)
