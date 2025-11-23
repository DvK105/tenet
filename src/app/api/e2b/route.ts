import { NextResponse } from 'next/server'
import { Sandbox } from 'e2b'

export const runtime = 'nodejs'

// Configuration
const SANDBOX_ALIAS = 'blender-renders'
const DEFAULT_WIDTH = 1024
const DEFAULT_HEIGHT = 768
const DEFAULT_FRAME = 1
const RENDER_SCRIPT_PATH = '/opt/blender/render.py'
const TEST_OUTPUT_PATH = '/tmp/test.png'

// Constants for file operations
const SCENE_FILE_PATH = '/tmp/scene.blend'
const OUTPUT_PATTERN = '/tmp/frame_####'

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
function getOutputFilePath(frame: number): string {
  const frameStr = String(frame).padStart(4, '0')
  return `/tmp/frame_${frameStr}.png`
}

// Helper: Build xvfb-run command
function buildRenderCommand(
  width: number,
  height: number,
  blendFile: string,
  outputPattern: string,
  frame: number
): string {
  return `xvfb-run -s "-screen 0 ${width}x${height}x24" blender -b ${blendFile} -o ${outputPattern} -f ${frame}`
}

// Handler: Built-in test render
async function handleBuiltinRender(sandbox: Sandbox): Promise<RenderResponse> {
  const cmd = `xvfb-run -s "-screen 0 ${DEFAULT_WIDTH}x${DEFAULT_HEIGHT}x24" blender -b -P ${RENDER_SCRIPT_PATH}`
  const result = await sandbox.commands.run(cmd)
  const imageBase64 = await readImageAsBase64(sandbox, TEST_OUTPUT_PATH)

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
  form: FormData
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
  await sandbox.files.write(SCENE_FILE_PATH, arrayBuffer)

  // Execute render command
  const cmd = buildRenderCommand(width, height, SCENE_FILE_PATH, OUTPUT_PATTERN, frame)
  const result = await sandbox.commands.run(cmd)

  // Read rendered output
  const outputPath = getOutputFilePath(frame)
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

  try {
    // Validate environment
    validateEnvironment()

    // Check content type
    const contentType = req.headers.get('content-type') || ''
    const isMultipart = contentType.includes('multipart/form-data')

    // Create sandbox
    sandbox = await Sandbox.create(SANDBOX_ALIAS)

    // Route to appropriate handler
    if (isMultipart) {
      const form = await req.formData()
      const response = await handleUploadRender(sandbox, form)
      return NextResponse.json<RenderResponse>(response)
    } else {
      const response = await handleBuiltinRender(sandbox)
      return NextResponse.json<RenderResponse>(response)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Render failed'
    return jsonError(message, 500)
  } finally {
    // Cleanup: Kill sandbox to free resources
    if (sandbox) {
      try {
        await sandbox.kill()
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}
