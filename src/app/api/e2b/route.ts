import { NextResponse } from 'next/server'
import { Sandbox } from 'e2b'

export const runtime = 'nodejs'

// Configuration
const SANDBOX_ALIAS = 'blender-renders'
const BLENDER_BIN = '/opt/blender-4.5.0-linux-x64/blender'
const DEFAULT_WIDTH = 1024
const DEFAULT_HEIGHT = 768
const DEFAULT_FRAME = 1
const RENDER_SCRIPT_PATH = '/opt/blender/render.py'
// Builtin render script writes to /tmp; we will copy the result into a secure dir before reading
const BUILTIN_TEST_OUTPUT_PATH = '/tmp/test.png'
// Timeout for Blender commands (280 seconds = 280000ms, leaving buffer before Vercel's 300s maxDuration)
const BLENDER_TIMEOUT_MS = 280_000
// Timeout for sandbox operations (30 seconds for creation, file ops, etc.)
const SANDBOX_OP_TIMEOUT_MS = 30_000
// Timeout for sandbox creation (60 seconds - can be slow)
const SANDBOX_CREATE_TIMEOUT_MS = 60_000

// Types
type RenderMode = 'builtin' | 'upload'

interface RenderResponse {
  ok: boolean
  mode: RenderMode
  stdout: string
  stderr: string
  imageBase64: string | null
  width?: number
  height?: number
  frame?: number
  error?: string
}

// Helper: Create error response
function jsonError(message: string, status = 400): NextResponse {
  return NextResponse.json<RenderResponse>(
    { ok: false, error: message, mode: 'builtin', stdout: '', stderr: '', imageBase64: null },
    { status }
  )
}

// Helper: Wrap async operations with timeout
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string
): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(errorMessage))
    }, timeoutMs)
  })
  return Promise.race([promise, timeoutPromise])
}

// Helper: Secure temp directory management inside sandbox
async function createSecureTmpDir(sandbox: Sandbox): Promise<string> {
  // mktemp -d creates a uniquely named directory with 0700 permissions
  const result = await withTimeout(
    sandbox.commands.run('mktemp -d /tmp/tenet-XXXXXX', { timeoutMs: SANDBOX_OP_TIMEOUT_MS }),
    SANDBOX_OP_TIMEOUT_MS,
    'Failed to create temp directory: operation timed out'
  )
  const dir = result.stdout.trim()
  if (!dir || !dir.startsWith('/tmp/')) {
    throw new Error('Failed to create secure temp directory')
  }
  return dir
}

async function cleanupTmpDir(sandbox: Sandbox, dir: string | null): Promise<void> {
  if (!dir) return
  try {
    // Best-effort cleanup with timeout to prevent hanging
    await withTimeout(
      sandbox.commands.run(`rm -rf -- "${dir}"`, { timeoutMs: 5000 }),
      5000,
      'Cleanup timed out (non-critical)'
    )
  } catch {
    // ignore cleanup errors
  }
}

// Helper: Read file and convert to base64
async function readImageAsBase64(
  sandbox: Sandbox,
  filePath: string
): Promise<string | null> {
  try {
    const file = await withTimeout(
      sandbox.files.read(filePath),
      SANDBOX_OP_TIMEOUT_MS,
      'Failed to read image file: operation timed out'
    )
    return Buffer.from(file).toString('base64')
  } catch {
    return null
  }
}

// Helper: Validate environment
function validateEnvironment(): void {
  if (!process.env.E2B_API_KEY) {
    throw new Error('E2B_API_KEY is not set in environment')
  }
}

// Helper: Parse render parameters from form data
function parseRenderParams(form: FormData) {
  return {
    width: Number(form.get('width') || DEFAULT_WIDTH),
    height: Number(form.get('height') || DEFAULT_HEIGHT),
    frame: Number(form.get('frame') || DEFAULT_FRAME),
  }
}

// Helper: Get output file path for a frame
function getOutputFilePath(tmpDir: string, frame: number): string {
  const frameStr = String(frame).padStart(4, '0')
  return `${tmpDir}/frame_${frameStr}.png`
}

// Helper: Build xvfb-run command
function buildRenderCommand(
  width: number,
  height: number,
  blendFile: string,
  outputPattern: string,
  frame: number
): string {
  // Quote paths to avoid shell interpretation issues
  return `xvfb-run -s "-screen 0 ${width}x${height}x24" ${BLENDER_BIN} -b "${blendFile}" -o "${outputPattern}" -f ${frame}`
}

// Handler: Built-in test render
async function handleBuiltinRender(sandbox: Sandbox, tmpDir: string): Promise<RenderResponse> {
  const cmd = `xvfb-run -s "-screen 0 ${DEFAULT_WIDTH}x${DEFAULT_HEIGHT}x24" ${BLENDER_BIN} -b -P ${RENDER_SCRIPT_PATH}`
  let result
  try {
    result = await sandbox.commands.run(cmd, { timeoutMs: BLENDER_TIMEOUT_MS })
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'
    if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
      throw new Error(`Render operation timed out after ${BLENDER_TIMEOUT_MS / 1000} seconds. The render may be too complex for the current timeout limit.`)
    }
    throw err
  }
  // Copy result from public /tmp into our secure dir before reading, if it exists
  await withTimeout(
    sandbox.commands.run(`if [ -f "${BUILTIN_TEST_OUTPUT_PATH}" ]; then cp "${BUILTIN_TEST_OUTPUT_PATH}" "${tmpDir}/test.png"; fi`, { timeoutMs: SANDBOX_OP_TIMEOUT_MS }),
    SANDBOX_OP_TIMEOUT_MS,
    'Failed to copy output file: operation timed out'
  )
  const imageBase64 = await readImageAsBase64(sandbox, `${tmpDir}/test.png`)

  return {
    ok: true,
    mode: 'builtin',
    stdout: result.stdout,
    stderr: result.stderr,
    imageBase64,
  }
}

// Handler: Upload and render custom .blend file
async function handleUploadRender(
  sandbox: Sandbox,
  form: FormData,
  tmpDir: string
): Promise<RenderResponse> {
  // Validate file upload
  const blendFile = form.get('blend')
  if (!blendFile || !(blendFile instanceof File)) {
    throw new Error('Upload a .blend file in field "blend"')
  }

  // Parse render parameters
  const { width, height, frame } = parseRenderParams(form)

  // Write .blend file to sandbox
  const arrayBuffer = await blendFile.arrayBuffer()
  const sceneFilePath = `${tmpDir}/scene.blend`
  await withTimeout(
    sandbox.files.write(sceneFilePath, arrayBuffer),
    SANDBOX_OP_TIMEOUT_MS,
    `Failed to write blend file to sandbox: operation timed out after ${SANDBOX_OP_TIMEOUT_MS / 1000} seconds. File may be too large.`
  )

  // Execute render command
  const outputPattern = `${tmpDir}/frame_####`
  const cmd = buildRenderCommand(width, height, sceneFilePath, outputPattern, frame)
  let result
  try {
    result = await sandbox.commands.run(cmd, { timeoutMs: BLENDER_TIMEOUT_MS })
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error'
    if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
      throw new Error(`Render operation timed out after ${BLENDER_TIMEOUT_MS / 1000} seconds. The render may be too complex for the current timeout limit.`)
    }
    throw err
  }

  // Read rendered output
  const outputPath = getOutputFilePath(tmpDir, frame)
  const imageBase64 = await readImageAsBase64(sandbox, outputPath)

  return {
    ok: true,
    mode: 'upload',
    stdout: result.stdout,
    stderr: result.stderr,
    width,
    height,
    frame,
    imageBase64,
  }
}

// Main POST handler
export async function POST(req: Request): Promise<NextResponse> {
  let sandbox: Sandbox | null = null
  let tmpDir: string | null = null

  try {
    // Validate environment
    validateEnvironment()

    // Check content type
    const contentType = req.headers.get('content-type') || ''
    const isMultipart = contentType.includes('multipart/form-data')

    // Create sandbox with timeout
    sandbox = await withTimeout(
      Sandbox.create(SANDBOX_ALIAS),
      SANDBOX_CREATE_TIMEOUT_MS,
      `Failed to create sandbox: operation timed out after ${SANDBOX_CREATE_TIMEOUT_MS / 1000} seconds. Please try again.`
    )
    // Create a secure, per-request temp directory inside sandbox
    tmpDir = await createSecureTmpDir(sandbox)

    // Route to appropriate handler
    if (isMultipart) {
      const form = await req.formData()
      const response = await handleUploadRender(sandbox, form, tmpDir)
      return NextResponse.json<RenderResponse>(response)
    } else {
      const response = await handleBuiltinRender(sandbox, tmpDir)
      return NextResponse.json<RenderResponse>(response)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Render failed'
    return jsonError(message, 500)
  } finally {
    // Cleanup: Kill sandbox to free resources
    if (sandbox) {
      // Clean up temp dir first
      await cleanupTmpDir(sandbox, tmpDir)
      try {
        // Kill sandbox with timeout to prevent hanging
        await withTimeout(
          sandbox.kill(),
          10000, // 10 second timeout for cleanup
          'Sandbox cleanup timed out (non-critical)'
        )
      } catch {
        // Ignore cleanup errors - sandbox will be cleaned up by E2B eventually
      }
    }
  }
}
