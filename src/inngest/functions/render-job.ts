import { inngest } from "../client"
import { createClient } from "@supabase/supabase-js"
import { Sandbox } from "e2b"

// Inngest function that will orchestrate a render job when a file is uploaded.
// Flow:
// 1. Download the uploaded .blend file from the `renders-input` bucket using the storage path from the event.
// 2. Start an e2b sandbox and create a secure temp directory.
// 3. Copy the .blend file into the sandbox filesystem.
// 4. Use Blender to auto-detect the scene frame range and render an image sequence.
// 5. Use ffmpeg (24 fps) to encode the frames into an MP4.
// 6. Upload the MP4 to the `renders-output` bucket.
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
      process.env.SUPABASE_OUTPUT_BUCKET_NAME || "renders-output"

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

    // Step 2–6: Use e2b sandbox to render frames, encode MP4, and upload to Supabase
    const videoPath = await step.run("render-and-upload", async () => {
      let sandbox: Sandbox | null = null
      let tmpDir: string | null = null
      try {
        sandbox = await Sandbox.create("blender-renders")

        // Create a secure temp directory, similar to /api/e2b
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

        // Build and run a Blender command that auto-detects frame range via Python
        // and renders an image sequence to tmpDir/frames/frame_####.png
        const framesDir = `${tmpDir}/frames`
        await sandbox.commands.run(`mkdir -p "${framesDir}"`)

        const pythonExpr =
          "import bpy, os; s=bpy.context.scene; start=s.frame_start; end=s.frame_end; " +
          `s.render.filepath='${framesDir}/frame_'; ` +
          "bpy.ops.render.render(animation=True)"

        const fullBlenderCmd = `xvfb-run -s "-screen 0 1920x1080x24" blender -b "${sceneFilePath}" --python-expr "${pythonExpr}"`

        try {
          const renderResult = await sandbox.commands.run(fullBlenderCmd)
          console.log("[render-job] blender stdout:", renderResult.stdout)
          console.log("[render-job] blender stderr:", renderResult.stderr)
        } catch (err: any) {
          console.error("[render-job] blender command failed", {
            message: err?.message,
            exitCode: err?.exitCode,
            stdout: err?.stdout,
            stderr: err?.stderr,
          })
          throw err
        }

        // After rendering frames, run ffmpeg at 24 fps to produce MP4
        const outputVideoPath = `${tmpDir}/output.mp4`
        const ffmpegCmd =
          `ffmpeg -y -framerate 24 -i "${framesDir}/frame_%04d.png" -c:v libx264 -pix_fmt yuv420p "${outputVideoPath}"`

        try {
          const ffmpegResult = await sandbox.commands.run(ffmpegCmd)
          console.log("[render-job] ffmpeg stdout:", ffmpegResult.stdout)
          console.log("[render-job] ffmpeg stderr:", ffmpegResult.stderr)
        } catch (err: any) {
          console.error("[render-job] ffmpeg command failed", {
            message: err?.message,
            exitCode: err?.exitCode,
            stdout: err?.stdout,
            stderr: err?.stderr,
          })
          throw err
        }

        // Read the MP4 from the sandbox; treat it as opaque binary data suitable for upload
        const fileData = (await sandbox.files.read(outputVideoPath)) as unknown as
          | ArrayBuffer
          | Blob
          | string

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

    return {
      ok: true,
      id,
      filename,
      outputBucket,
      outputPath: videoPath,
    }
  },
)
