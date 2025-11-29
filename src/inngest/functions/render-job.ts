import { inngest } from "../client"
import { createClient } from "@supabase/supabase-js"
import { Sandbox } from "e2b"

const BLENDER_BIN = "/opt/blender-4.0.0-linux-x64/blender"

// Inngest function that will orchestrate a render job when a file is uploaded.
// Flow:
// 1. Download the uploaded .blend file from the `renders-input` bucket using the storage path from the event.
// 2. Start an e2b sandbox with template and create a secure temp directory.
// 3. Copy the .blend file into the sandbox filesystem.
// 4. Use Blender to auto-detect the scene frame range and render an image sequence (with periodic checkpoints every 4 minutes).
// 5. Use ffmpeg (24 fps) to encode the frames into an MP4.
// 6. Upload the MP4 to the `render-output` bucket.
// 7. Return metadata (and later, optionally update a jobs table).
export const renderJob = inngest.createFunction(
  { id: "render-job" },
  { event: "render/uploaded" },
  async ({ event, step }) => {
    const { id, filename } = event.data as { id: string; filename: string }

    await step.run("log-render-job-received", async () => {
      console.log("[render-job] received event", { id, filename })
    })

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

    // Step 1: Download the input file from Supabase storage as an ArrayBuffer
    const blendArrayBuffer = await step.run(
      "download-input-from-supabase",
      async () => {
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

        const arrayBuffer = await data.arrayBuffer()
        // Ensure we treat this as a standard ArrayBuffer for the sandbox API
        return arrayBuffer as ArrayBuffer
      },
    )

    // Step 2: Create checkpoint to avoid timeout
    await step.sleep("checkpoint-1", "4m")

    // Step 3: Create e2b sandbox, setup, render, encode, and upload
    // Following eduvids architecture: keep sandbox operations in one step
    // but use step.sleep() calls to create periodic checkpoints
    // The sandbox stays alive within the step.run() execution context
    const videoPath = await step.run("create-sandbox-and-render", async () => {
      let sandbox: Sandbox | null = null
      let tmpDir: string | null = null

      try {
        // Create sandbox with template
        sandbox = await Sandbox.create("blender-renders")
        console.log("[render-job] sandbox created", { sandboxId: sandbox.sandboxId })

        // Create a secure temp directory
        const tmpResult = await sandbox.commands.run(
          "mktemp -d /tmp/tenet-XXXXXX",
        )
        const dir = tmpResult.stdout.trim()
        if (!dir || !dir.startsWith("/tmp/")) {
          throw new Error("Failed to create secure temp directory in sandbox")
        }
        tmpDir = dir

        // Write the .blend file into the sandbox
        const sceneFilePath = `${tmpDir}/scene.blend`
        await sandbox.files.write(sceneFilePath, blendArrayBuffer as ArrayBuffer)
        console.log("[render-job] wrote blend file to sandbox", { sceneFilePath })

        // Verify file was written
        const verifyFile = await sandbox.commands.run(`test -f "${sceneFilePath}" && echo "exists" || echo "missing"`)
        if (!verifyFile.stdout.includes("exists")) {
          throw new Error(`Failed to verify blend file exists at ${sceneFilePath}`)
        }

        // Create frames directory
        const framesDir = `${tmpDir}/frames`
        await sandbox.commands.run(`mkdir -p "${framesDir}"`)
        console.log("[render-job] created frames directory", { framesDir })

        // Create a Python script for rendering
        const renderScriptPath = `${tmpDir}/render.py`
        const renderScript = `import bpy
import os

# Get the scene
s = bpy.context.scene

# Set output path
frames_dir = r'${framesDir}'
s.render.filepath = os.path.join(frames_dir, 'frame_')

# Render animation
print(f"Rendering from frame {s.frame_start} to {s.frame_end}")
print(f"Output path: {s.render.filepath}")
bpy.ops.render.render(animation=True)
print("Render complete")
`
        await sandbox.files.write(renderScriptPath, renderScript)
        console.log("[render-job] created render script", { renderScriptPath })

        // Build and run a Blender command using the Python script
        const fullBlenderCmd = `xvfb-run -s "-screen 0 1920x1080x24" ${BLENDER_BIN} -b "${sceneFilePath}" -P "${renderScriptPath}"`

        console.log("[render-job] executing blender command")
        try {
          const renderResult = await sandbox.commands.run(fullBlenderCmd)
          console.log("[render-job] blender stdout:", renderResult.stdout)
          console.log("[render-job] blender stderr:", renderResult.stderr)
          
          // Check if any frames were rendered
          const checkFrames = await sandbox.commands.run(`ls -1 "${framesDir}" | wc -l`)
          const frameCount = parseInt(checkFrames.stdout.trim())
          console.log("[render-job] frames rendered:", frameCount)
          
          if (frameCount === 0) {
            throw new Error("No frames were rendered. Check Blender output for errors.")
          }
        } catch (err: any) {
          console.error("[render-job] blender command failed", {
            message: err?.message,
            exitCode: err?.exitCode,
            stdout: err?.stdout,
            stderr: err?.stderr,
          })
          throw new Error(
            `Blender render failed: ${err?.message || "Unknown error"}. Exit code: ${err?.exitCode || "unknown"}. Stderr: ${err?.stderr || "none"}`
          )
        }

        // After rendering frames, run ffmpeg at 24 fps to produce MP4
        const outputVideoPath = `${tmpDir}/output.mp4`
        
        // Check frame files before encoding
        const listFrames = await sandbox.commands.run(`ls -1 "${framesDir}" | head -5`)
        console.log("[render-job] sample frame files:", listFrames.stdout)
        
        const ffmpegCmd =
          `ffmpeg -y -framerate 24 -i "${framesDir}/frame_%04d.png" -c:v libx264 -pix_fmt yuv420p -crf 23 "${outputVideoPath}"`

        console.log("[render-job] executing ffmpeg command")
        try {
          const ffmpegResult = await sandbox.commands.run(ffmpegCmd)
          console.log("[render-job] ffmpeg stdout:", ffmpegResult.stdout)
          console.log("[render-job] ffmpeg stderr:", ffmpegResult.stderr)
          
          // Verify video was created
          const verifyVideo = await sandbox.commands.run(`test -f "${outputVideoPath}" && echo "exists" || echo "missing"`)
          if (!verifyVideo.stdout.includes("exists")) {
            throw new Error("FFmpeg completed but output video file was not created")
          }
          
          const videoSize = await sandbox.commands.run(`stat -c%s "${outputVideoPath}"`)
          console.log("[render-job] video file size:", videoSize.stdout.trim(), "bytes")
        } catch (err: any) {
          console.error("[render-job] ffmpeg command failed", {
            message: err?.message,
            exitCode: err?.exitCode,
            stdout: err?.stdout,
            stderr: err?.stderr,
          })
          throw new Error(
            `FFmpeg encoding failed: ${err?.message || "Unknown error"}. Exit code: ${err?.exitCode || "unknown"}. Stderr: ${err?.stderr || "none"}`
          )
        }

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
        if (sandbox && tmpDir) {
          try {
            await sandbox.commands.run(`rm -rf -- "${tmpDir}"`)
          } catch {
            // ignore cleanup errors
          }
        }
        if (sandbox) {
          try {
            await sandbox.kill()
          } catch {
            // ignore
          }
        }
      }
    })

    // Step 4: Create final checkpoint
    await step.sleep("checkpoint-2", "4m")

    return {
      ok: true,
      id,
      filename,
      outputBucket,
      outputPath: videoPath,
    }
  },
)
