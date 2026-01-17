import { NextRequest } from "next/server"
import { Sandbox } from "e2b"
import { getRenderObjectUrl, getSupabaseRendersBucket, hasSupabaseConfig, tryGetSupabaseAdmin } from "@/lib/supabase-admin"

export const runtime = "nodejs"
export const maxDuration = 300

type RenderProgress = {
  status?: "rendering" | "completed" | "cancelled"
  frameStart?: number
  frameEnd?: number
  frameCount?: number
  currentFrame?: number
  framesDone?: number
  startedAt?: number
  updatedAt?: number
}

function decodeSandboxText(value: unknown): string {
  if (typeof value === "string") return value
  if (Buffer.isBuffer(value)) return value.toString("utf-8")
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("utf-8")
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer).toString("utf-8")
  return Buffer.from(value as ArrayBuffer).toString("utf-8")
}

function safeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  return undefined
}

async function checkRenderStatus(renderId: string): Promise<{
  status: "rendering" | "completed" | "error"
  progress?: number
  etaSeconds?: number
  videoUrl?: string
  errorMessage?: string
}> {
  // First check Supabase Storage
  if (hasSupabaseConfig()) {
    try {
      const supabase = tryGetSupabaseAdmin()
      if (supabase) {
        const bucket = getSupabaseRendersBucket()
        const objectPath = `${renderId}.mp4`

        const { data, error } = await supabase.storage.from(bucket).list("", {
          limit: 1,
          search: objectPath,
        })

        if (!error && Array.isArray(data) && data.some((o) => o.name === objectPath)) {
          const url = await getRenderObjectUrl(objectPath)
          return {
            status: "completed",
            progress: 100,
            etaSeconds: 0,
            videoUrl: url,
          }
        }
      }
    } catch {
      // Fall through to sandbox check
    }
  }

  // Check local storage
  try {
    const { existsSync } = await import("fs")
    const { join } = await import("path")
    const videoPath = join(process.cwd(), "public", "renders", `${renderId}.mp4`)
    if (existsSync(videoPath)) {
      return {
        status: "completed",
        progress: 100,
        etaSeconds: 0,
        videoUrl: `/renders/${renderId}.mp4`,
      }
    }
  } catch {
    // Continue to sandbox check
  }

  // Try to read progress from sandbox (if it exists)
  // Note: This requires the renderId to be a sandboxId
  // In production, you might want to maintain a mapping of renderId -> sandboxId
  try {
    const sandbox = await Sandbox.connect(renderId, { timeoutMs: 10_000 })
    const files = await sandbox.files.list("/tmp")
    const hasMp4 = files.some((f: { name: string }) => f.name === "output.mp4")

    if (hasMp4) {
      return {
        status: "completed",
        progress: 100,
        etaSeconds: 0,
      }
    }

    // Try to read progress file
    try {
      const raw = await sandbox.files.read("/tmp/render_progress.json")
      const text = decodeSandboxText(raw)
      const progress = JSON.parse(text) as RenderProgress

      if (progress.status === "completed") {
        return {
          status: "completed",
          progress: 100,
          etaSeconds: 0,
        }
      }

      if (progress.status === "rendering") {
        const frameCount = progress.frameCount || 1
        const framesDone = progress.framesDone || 0
        const progressPercent = Math.min(100, Math.max(0, (framesDone / frameCount) * 100))

        // Calculate ETA
        let etaSeconds = 0
        if (progress.startedAt && progress.updatedAt && framesDone > 0) {
          const elapsed = progress.updatedAt - progress.startedAt
          const framesPerSecond = framesDone / elapsed
          const remainingFrames = frameCount - framesDone
          etaSeconds = framesPerSecond > 0 ? Math.round(remainingFrames / framesPerSecond) : 0
        }

        return {
          status: "rendering",
          progress: progressPercent,
          etaSeconds,
        }
      }
    } catch {
      // Progress file doesn't exist or can't be read
    }
  } catch {
    // Sandbox doesn't exist or can't be connected
  }

  return {
    status: "rendering",
    progress: 0,
  }
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const renderIds = searchParams.getAll("renderId")

  if (renderIds.length === 0) {
    return new Response("No renderIds provided", { status: 400 })
  }

  // Set up SSE headers
  const headers = new Headers({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // Disable nginx buffering
  })

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()

      // Send initial connection message
      controller.enqueue(encoder.encode(": connected\n\n"))

      const pollInterval = 5000 // Poll every 5 seconds
      let isActive = true

      const poll = async () => {
        if (!isActive) return

        try {
          const results = await Promise.all(
            renderIds.map(async (renderId) => {
              try {
                const status = await checkRenderStatus(renderId)
                return { renderId, ...status }
              } catch (error) {
                console.error(`Error checking status for ${renderId}:`, error)
                return {
                  renderId,
                  status: "error" as const,
                  errorMessage: error instanceof Error ? error.message : "Unknown error",
                }
              }
            })
          )

          // Send updates for each render
          for (const result of results) {
            const event: {
              type: "progress" | "completed" | "error"
              renderId: string
              data: {
                status?: "rendering" | "completed" | "error"
                progress?: number
                etaSeconds?: number
                videoUrl?: string
                errorMessage?: string
              }
            } = {
              type: result.status === "completed" ? "completed" : result.status === "error" ? "error" : "progress",
              renderId: result.renderId,
              data: {
                status: result.status,
                progress: result.progress,
                etaSeconds: result.etaSeconds,
                videoUrl: result.videoUrl,
                errorMessage: result.errorMessage,
              },
            }

            const message = `data: ${JSON.stringify(event)}\n\n`
            controller.enqueue(encoder.encode(message))
          }

          // Check if all renders are completed
          const allCompleted = results.every((r) => r.status === "completed" || r.status === "error")
          if (allCompleted) {
            // Keep connection open for a bit longer in case of late updates, then close
            setTimeout(() => {
              isActive = false
              controller.close()
            }, 10000)
            return
          }

          // Schedule next poll
          setTimeout(poll, pollInterval)
        } catch (error) {
          console.error("Error in SSE poll:", error)
          // Continue polling even on error
          setTimeout(poll, pollInterval)
        }
      }

      // Start polling
      poll()

      // Cleanup on client disconnect
      request.signal.addEventListener("abort", () => {
        isActive = false
        controller.close()
      })
    },
  })

  return new Response(stream, { headers })
}
