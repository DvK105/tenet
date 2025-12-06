import { inngest } from "../client"
import { createClient } from "@supabase/supabase-js"
import type { SupabaseClient } from "@supabase/supabase-js"
import { Sandbox } from "e2b"

const BLENDER_BIN = "/opt/blender-4.5.0-linux-x64/blender"
// Render resolution - can be overridden via environment variables: RENDER_WIDTH, RENDER_HEIGHT
const DEFAULT_RENDER_WIDTH = parsePositiveInteger(process.env.RENDER_WIDTH, 1920)
const DEFAULT_RENDER_HEIGHT = parsePositiveInteger(process.env.RENDER_HEIGHT, 1080)
// Frame to render (default: frame 1)
const RENDER_FRAME = parsePositiveInteger(process.env.RENDER_FRAME, 1)

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseTimeout(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

// Timeout for single frame rendering (5 minutes)
const RENDER_TIMEOUT_MS = parseTimeout(process.env.RENDER_TIMEOUT_MS, 300_000)

type SupabaseContext = {
  supabase: SupabaseClient<any, any, any>
  inputBucket: string
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

    return {
      sandboxId: sandbox.sandboxId,
      tmpDir,
    }
  } catch (err) {
    await cleanupOnError()
    throw err
  }
}

async function renderSingleFrame({
  sandboxId,
  tmpDir,
  frameNumber,
}: {
  sandboxId: string
  tmpDir: string
  frameNumber: number
}): Promise<string> {
  console.log(`[render-job] Rendering frame ${frameNumber}`)

  let sandbox: Sandbox
  try {
    sandbox = await Sandbox.connect(sandboxId)
    console.log(`[render-job] Reconnected to sandbox: ${sandboxId}`)
  } catch (err) {
    logError("sandbox-reconnect", err, { sandboxId, frameNumber })
    throw new Error(
      `Failed to reconnect to sandbox ${sandboxId} for frame ${frameNumber}. Sandbox may have timed out. Error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const sceneFilePath = `${tmpDir}/scene.blend`
  const outputImagePath = `${tmpDir}/frame_${String(frameNumber).padStart(4, '0')}.png`
  const renderScriptPath = `${tmpDir}/render_frame.py`

  const renderScript = `import bpy
import os
import sys

try:
    s = bpy.context.scene
    
    # Set render resolution
    s.render.resolution_x = ${DEFAULT_RENDER_WIDTH}
    s.render.resolution_y = ${DEFAULT_RENDER_HEIGHT}
    s.render.resolution_percentage = 100
    
    # Set output path for single frame
    s.render.filepath = r'${outputImagePath}'
    
    # Set frame to render
    s.frame_set(${frameNumber})
    
    # Render settings - can be optimized later
    s.render.tile_x = 256
    s.render.tile_y = 256
    
    print(f"Rendering frame ${frameNumber} at {s.render.resolution_x}x{s.render.resolution_y}")
    bpy.ops.render.render(write_still=True)
    print(f"Render complete: frame ${frameNumber}")
    sys.exit(0)
except Exception as e:
    print(f"Error during rendering: {e}", file=sys.stderr)
    import traceback
    traceback.print_exc(file=sys.stderr)
    sys.exit(1)
`

  try {
    await sandbox.files.write(renderScriptPath, renderScript)
  } catch (err) {
    logError("render-script-write", err, { renderScriptPath, frameNumber })
    throw new Error(`Failed to write render script: ${err instanceof Error ? err.message : String(err)}`)
  }

  try {
    // Use xvfb-run with auto-display selection for headless rendering
    const renderResult = await sandbox.commands.run(
      `xvfb-run -a -s "-screen 0 ${DEFAULT_RENDER_WIDTH}x${DEFAULT_RENDER_HEIGHT}x24" ${BLENDER_BIN} -b "${sceneFilePath}" -P "${renderScriptPath}"`,
      { timeoutMs: RENDER_TIMEOUT_MS },
    )
    console.log(`[render-job] Frame ${frameNumber} render stdout:`, renderResult.stdout)
    if (renderResult.stderr) {
      console.log(`[render-job] Frame ${frameNumber} render stderr:`, renderResult.stderr)
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    const exitCode = (err as any)?.exitCode
    const isTimeout = errorMessage.includes('timeout') || errorMessage.includes('Timeout') || errorMessage.includes('timed out')
    // Exit code 137 = SIGKILL, typically from OOM killer (128 + 9)
    const isOOM = exitCode === 137 || exitCode === '137'
    
    logError("blender-render", err, {
      frameNumber,
      stdout: (err as any)?.stdout,
      stderr: (err as any)?.stderr,
      exitCode,
      isTimeout,
      isOOM,
    })
    
    if (isOOM) {
      throw new Error(
        `Blender render was killed due to out-of-memory (OOM) for frame ${frameNumber}. Exit code: 137. Try reducing render resolution or simplifying the scene.`
      )
    }
    
    if (isTimeout) {
      throw new Error(
        `Blender render timed out for frame ${frameNumber} after ${RENDER_TIMEOUT_MS / 1000} seconds. The render may be too complex.`
      )
    }
    
    throw new Error(
      `Blender render failed for frame ${frameNumber}: ${errorMessage}. Exit code: ${exitCode || "unknown"}. Stderr: ${(err as any)?.stderr || "none"}`,
    )
  }

  // Verify the image was created
  try {
    const verifyImage = await sandbox.commands.run(`test -f "${outputImagePath}" && echo "exists" || echo "missing"`)
    if (!verifyImage.stdout.includes("exists")) {
      throw new Error(`Render completed but output image was not created at ${outputImagePath}`)
    }
    console.log(`[render-job] Frame ${frameNumber} rendered successfully: ${outputImagePath}`)
  } catch (err) {
    logError("image-verification", err, { frameNumber, outputImagePath })
    throw new Error(`Failed to verify rendered image: ${err instanceof Error ? err.message : String(err)}`)
  }

  return outputImagePath
}

async function uploadImage({
  sandboxId,
  imagePath,
  id,
  frameNumber,
  outputBucket,
  supabase,
}: {
  sandboxId: string
  imagePath: string
  id: string
  frameNumber: number
  outputBucket: string
  supabase: SupabaseClient<any, any, any>
}): Promise<string> {
  let sandbox: Sandbox
  try {
    sandbox = await Sandbox.connect(sandboxId)
    console.log(`[render-job] Reconnected to sandbox for upload: ${sandboxId}`)
  } catch (err) {
    logError("sandbox-reconnect-upload", err, { sandboxId })
    throw new Error(
      `Failed to reconnect to sandbox ${sandboxId} for upload. Sandbox may have timed out. Error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // Read the image file from sandbox
  let fileData: ArrayBuffer | Blob | string
  try {
    fileData = (await sandbox.files.read(imagePath)) as unknown as ArrayBuffer | Blob | string
  } catch (err) {
    logError("image-read", err, { imagePath })
    throw new Error(`Failed to read image file from sandbox: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Upload to Supabase
  const frameStr = String(frameNumber).padStart(4, '0')
  const uploadPath = `jobs/${id}/frame_${frameStr}.png`
  let uploadResult: any
  try {
    uploadResult = await supabase.storage.from(outputBucket).upload(uploadPath, fileData, {
      contentType: "image/png",
      upsert: true,
    })
  } catch (err) {
    logError("supabase-upload", err, { bucket: outputBucket, path: uploadPath })
    throw new Error(`Failed to upload image to Supabase: ${err instanceof Error ? err.message : String(err)}`)
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

  console.log(`[render-job] Image uploaded successfully: ${uploadResult.data?.path || uploadPath}`)

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
  { id: "render-job" },
  { event: "render/uploaded" },
  async ({ event, step }) => {
    const { id, filename } = event.data as { id: string; filename: string }

    console.log(`[render-job] Starting single frame render for file: ${filename} (id: ${id})`)

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

    // Step 1: Setup - download file, create sandbox
    const setup = await step.run("setup-job", () =>
      setupRenderJob({ id, filename, supabase, inputBucket }),
    )

    const { sandboxId, tmpDir } = setup

    let imagePath: string
    let uploadedPath: string

    try {
      // Step 2: Render single frame
      imagePath = await step.run("render-frame", () =>
        renderSingleFrame({ sandboxId, tmpDir, frameNumber: RENDER_FRAME }),
      )

      // Step 3: Upload image to Supabase
      uploadedPath = await step.run("upload-image", () =>
        uploadImage({
          sandboxId,
          imagePath,
          id,
          frameNumber: RENDER_FRAME,
          outputBucket,
          supabase,
        }),
      )
    } finally {
      // Step 4: Cleanup sandbox
      console.log(`[render-job] Cleaning up sandbox: ${sandboxId}`)
      await cleanupSandboxById(sandboxId, tmpDir)
    }

    console.log(`[render-job] Single frame render completed successfully for file: ${filename}`)

    return {
      ok: true,
      id,
      filename,
      frameNumber: RENDER_FRAME,
      outputBucket,
      outputPath: uploadedPath,
      message: `Frame ${RENDER_FRAME} rendered successfully. Image available at: ${uploadedPath}`,
    }
  },
)

export const renderJobFunctions = [renderJob]
