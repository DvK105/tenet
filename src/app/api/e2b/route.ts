import { NextResponse } from 'next/server'
import { Sandbox } from 'e2b'

export const runtime = 'nodejs'

// Configuration
const SANDBOX_ALIAS = 'blender-renders'
const DEFAULT_WIDTH = 1024
const DEFAULT_HEIGHT = 768
const DEFAULT_FRAME = 1
const RENDER_SCRIPT_PATH = '/opt/blender/render.py'
// Builtin render script writes to /tmp; we will copy the result into a secure dir before reading
const BUILTIN_TEST_OUTPUT_PATH = '/tmp/test.png'

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

// Helper: Secure temp directory management inside sandbox
async function createSecureTmpDir(sandbox: Sandbox): Promise<string> {
  // mktemp -d creates a uniquely named directory with 0700 permissions
  const result = await sandbox.commands.run('mktemp -d /tmp/tenet-XXXXXX')
  const dir = result.stdout.trim()
  if (!dir || !dir.startsWith('/tmp/')) {
    throw new Error('Failed to create secure temp directory')
  }
  return dir
}

async function cleanupTmpDir(sandbox: Sandbox, dir: string | null): Promise<void> {
  if (!dir) return
  try {
    // Best-effort cleanup
    await sandbox.commands.run(`rm -rf -- "${dir}"`)
  } catch {
    // ignore
  }
}

// Helper: Read file and convert to base64
async function readImageAsBase64(
  sandbox: Sandbox,
  filePath: string
): Promise<string | null> {
  try {
    const file = await sandbox.files.read(filePath)
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
  return `xvfb-run -s "-screen 0 ${width}x${height}x24" blender -b "${blendFile}" -o "${outputPattern}" -f ${frame}`
}

// Handler: Built-in test render
async function handleBuiltinRender(sandbox: Sandbox, tmpDir: string): Promise<RenderResponse> {
  const cmd = `xvfb-run -s "-screen 0 ${DEFAULT_WIDTH}x${DEFAULT_HEIGHT}x24" blender -b -P ${RENDER_SCRIPT_PATH}`
  const result = await sandbox.commands.run(cmd)
  // Copy result from public /tmp into our secure dir before reading, if it exists
  await sandbox.commands.run(`if [ -f "${BUILTIN_TEST_OUTPUT_PATH}" ]; then cp "${BUILTIN_TEST_OUTPUT_PATH}" "${tmpDir}/test.png"; fi`)
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
  await sandbox.files.write(sceneFilePath, arrayBuffer)

  // Execute render command
  const outputPattern = `${tmpDir}/frame_####`
  const cmd = buildRenderCommand(width, height, sceneFilePath, outputPattern, frame)
  const result = await sandbox.commands.run(cmd)

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

    // Create sandbox
    sandbox = await Sandbox.create(SANDBOX_ALIAS)
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
        await sandbox.kill()
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
