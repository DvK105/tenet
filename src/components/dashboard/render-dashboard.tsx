"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Sidebar } from "@/components/dashboard/sidebar"
import { Header } from "@/components/dashboard/header"
import { UploadZone } from "@/components/dashboard/upload-zone"
import { RenderQueue } from "@/components/dashboard/render-queue"
import { PerformanceGraph } from "@/components/dashboard/performance-graph"
import { SystemStatus } from "@/components/dashboard/system-status"
import { getSupabaseBrowserClient, getSupabaseInputsBucket } from "@/lib/supabase-browser"
import { SSEClient } from "@/lib/sse-client"
import { retryFetch } from "@/lib/retry"
import { toast } from "sonner"

type RenderStatusResponse = {
  status?: "rendering" | "completed" | "error"
  progress?: number
  etaSeconds?: number
  videoUrl?: string
  fileSize?: number
  frameCount?: number
  framesDone?: number
}

type RenderJob = {
  id: string
  fileName: string
  createdAt: number
  completedAt?: number
  status: "uploading" | "rendering" | "completed" | "error"
  progress?: number
  etaSeconds?: number
  videoUrl?: string
  errorMessage?: string
  fileSize?: number
}

export function RenderDashboard() {
  const [jobs, setJobs] = useState<RenderJob[]>([])
  const [currentPage, setCurrentPage] = useState<"upload" | "graph" | "status" | "account">("upload")

  const jobsRef = useRef<RenderJob[]>([])
  const pollIntervalRef = useRef<number | null>(null)
  const sseClientRef = useRef<SSEClient | null>(null)
  const pollRetryCountRef = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    jobsRef.current = jobs
  }, [jobs])

  const renderingJobs = useMemo(() => jobs.filter((j) => j.status === "rendering"), [jobs])
  const hasRenderingJobs = renderingJobs.length > 0

  // SSE connection for real-time updates
  useEffect(() => {
    if (!hasRenderingJobs) {
      if (sseClientRef.current) {
        sseClientRef.current.disconnect()
        sseClientRef.current = null
      }
      return
    }

    // Initialize SSE client if not exists
    if (!sseClientRef.current) {
      sseClientRef.current = new SSEClient("/api/render-events")
    }

    const renderIds = renderingJobs.map((j) => j.id)
    sseClientRef.current.updateRenderIds(renderIds)

    // Subscribe to updates for each rendering job
    const unsubscribes: Array<() => void> = []
    for (const job of renderingJobs) {
      const unsubscribe = sseClientRef.current.subscribe(job.id, (event) => {
        setJobs((prev) =>
          prev.map((j) => {
            if (j.id !== event.renderId) return j

            const nextStatus: RenderJob["status"] =
              event.data.status === "completed"
                ? "completed"
                : event.data.status === "error"
                  ? "error"
                  : "rendering"

            return {
              ...j,
              status: nextStatus,
              progress: typeof event.data.progress === "number" ? event.data.progress : j.progress,
              etaSeconds:
                typeof event.data.etaSeconds === "number" ? event.data.etaSeconds : j.etaSeconds,
              videoUrl: typeof event.data.videoUrl === "string" ? event.data.videoUrl : j.videoUrl,
              errorMessage:
                typeof event.data.errorMessage === "string" ? event.data.errorMessage : j.errorMessage,
              completedAt: nextStatus === "completed" ? Date.now() : j.completedAt,
            }
          })
        )
      })
      unsubscribes.push(unsubscribe)
    }

    return () => {
      unsubscribes.forEach((unsub) => unsub())
    }
  }, [hasRenderingJobs, renderingJobs.map((j) => j.id).join(",")])

  // Fallback polling when SSE is not available or fails
  useEffect(() => {
    const pollOnce = async () => {
      const targets = jobsRef.current.filter((j) => j.status === "rendering")
      if (targets.length === 0) return

      await Promise.all(
        targets.map(async (job) => {
          try {
            const res = await retryFetch(
              `/api/render-status?sandboxId=${encodeURIComponent(job.id)}`,
              {
                cache: "no-store",
              },
              {
                maxAttempts: 2, // Fewer retries for polling
                initialDelayMs: 500,
              }
            )

            if (!res.ok) {
              // Increment retry count
              const retryCount = pollRetryCountRef.current.get(job.id) || 0
              pollRetryCountRef.current.set(job.id, retryCount + 1)
              return
            }

            // Reset retry count on success
            pollRetryCountRef.current.delete(job.id)

            const data = (await res.json()) as RenderStatusResponse

            setJobs((prev) =>
              prev.map((j) => {
                if (j.id !== job.id) return j

                const nextStatus: RenderJob["status"] =
                  data.status === "completed"
                    ? "completed"
                    : data.status === "error"
                      ? "error"
                      : "rendering"

                return {
                  ...j,
                  status: nextStatus,
                  progress: typeof data.progress === "number" ? data.progress : j.progress,
                  etaSeconds: typeof data.etaSeconds === "number" ? data.etaSeconds : j.etaSeconds,
                  videoUrl: typeof data.videoUrl === "string" ? data.videoUrl : j.videoUrl,
                  fileSize: typeof data.fileSize === "number" ? data.fileSize : j.fileSize,
                  completedAt: nextStatus === "completed" ? Date.now() : j.completedAt,
                }
              })
            )
          } catch (error) {
            // Increment retry count on error
            const retryCount = pollRetryCountRef.current.get(job.id) || 0
            pollRetryCountRef.current.set(job.id, retryCount + 1)

            // Only log after multiple failures
            if (retryCount >= 3) {
              console.error(`Polling failed for job ${job.id}:`, error)
            }
          }
        })
      )
    }

    // Only use polling as fallback if SSE is not connected
    const usePolling = hasRenderingJobs && (!sseClientRef.current || !sseClientRef.current.isConnected())

    if (!usePolling) {
      if (pollIntervalRef.current !== null) {
        window.clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
      return
    }

    // Poll immediately, then set interval
    void pollOnce()

    if (pollIntervalRef.current === null) {
      // Poll every 5 seconds for active renders
      pollIntervalRef.current = window.setInterval(pollOnce, 5000)
    }

    return () => {
      if (pollIntervalRef.current !== null) {
        window.clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }
  }, [hasRenderingJobs])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (sseClientRef.current) {
        sseClientRef.current.disconnect()
        sseClientRef.current = null
      }
      if (pollIntervalRef.current !== null) {
        window.clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }
  }, [])

  const refreshRenderingJobs = async () => {
    const targets = jobs.filter((j) => j.status === "rendering")
    if (targets.length === 0) return

    await Promise.all(
      targets.map(async (job) => {
        try {
          const res = await retryFetch(
            `/api/render-status?sandboxId=${encodeURIComponent(job.id)}`,
            {
              cache: "no-store",
            },
            {
              maxAttempts: 2,
              initialDelayMs: 500,
            }
          )
          if (!res.ok) return
          const data = (await res.json()) as RenderStatusResponse

          setJobs((prev) =>
            prev.map((j) => {
              if (j.id !== job.id) return j

              const nextStatus: RenderJob["status"] =
                data.status === "completed"
                  ? "completed"
                  : data.status === "error"
                    ? "error"
                    : "rendering"

              return {
                ...j,
                status: nextStatus,
                progress: typeof data.progress === "number" ? data.progress : j.progress,
                etaSeconds: typeof data.etaSeconds === "number" ? data.etaSeconds : j.etaSeconds,
                videoUrl: typeof data.videoUrl === "string" ? data.videoUrl : j.videoUrl,
              }
            })
          )
        } catch {
          // ignore
        }
      })
    )
  }

  const handleUpload = async (newFiles: File[]) => {
    await Promise.all(
      newFiles.map(async (file) => {
        const renderId = crypto.randomUUID()
        setJobs((prev) => [
          {
            id: renderId,
            fileName: file.name,
            createdAt: Date.now(),
            status: "uploading",
            progress: 0,
          },
          ...prev,
        ])

        try {
          const supabase = getSupabaseBrowserClient()
          if (!supabase) {
            // Supabase not configured, skip upload and continue without toast
            setJobs((prev) =>
              prev.map((j) => (j.id === renderId ? { ...j, status: "error", errorMessage: "Supabase not configured" } : j))
            )
            return
          }
          const bucket = getSupabaseInputsBucket()
          const inputObjectPath = `${renderId}.blend`

          const { error: uploadError } = await supabase.storage
            .from(bucket)
            .upload(inputObjectPath, file, {
              upsert: true,
              contentType: "application/octet-stream",
            })

          if (uploadError) {
            const msg = `Supabase upload failed: ${uploadError.message}`
            toast.error(msg)
            setJobs((prev) =>
              prev.map((j) => (j.id === renderId ? { ...j, status: "error", errorMessage: msg } : j))
            )
            return
          }

          const res = await retryFetch(
            "/api/trigger-render",
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
              },
              body: JSON.stringify({
                renderId,
                inputObjectPath,
              }),
            },
            {
              maxAttempts: 3,
              initialDelayMs: 1000,
            }
          )

          if (!res.ok) {
            let details = ""
            try {
              details = await res.text()
            } catch {
              details = ""
            }
            const msg = `Trigger render failed (${res.status}): ${details || res.statusText}`
            toast.error(msg)
            setJobs((prev) =>
              prev.map((j) => (j.id === renderId ? { ...j, status: "error", errorMessage: msg } : j))
            )
            return
          }

          setJobs((prev) =>
            prev.map((j) =>
              j.id === renderId
                ? {
                    ...j,
                    status: "rendering",
                    errorMessage: undefined,
                  }
                : j
            )
          )
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          // Suppress toasts for Supabase URL configuration errors
          if (!msg.includes("NEXT_PUBLIC_SUPABASE_URL") && !msg.includes("NEXT_PUBLIC_SUPABASE_ANON_KEY")) {
            toast.error(msg)
          }
          setJobs((prev) =>
            prev.map((j) => (j.id === renderId ? { ...j, status: "error", errorMessage: msg } : j))
          )
        }
      })
    )
  }

  return (
    <div className="flex h-screen w-full bg-background text-foreground">
      <Sidebar currentPage={currentPage} onPageChange={setCurrentPage} />
      <div className="flex-1 flex flex-col min-w-0 relative z-0">
        <Header />

        <div className="flex-1 p-6 bg-grid-pattern overflow-hidden">
          {currentPage === "upload" && (
            <div className="h-full grid grid-rows-2 gap-6">
              <UploadZone onUpload={handleUpload} />
              <RenderQueue
                jobs={jobs}
                onRefresh={refreshRenderingJobs}
                onClear={() => setJobs([])}
              />
            </div>
          )}

          {currentPage === "graph" && (
            <div className="h-full">
              <PerformanceGraph jobs={jobs} />
            </div>
          )}

          {currentPage === "status" && (
            <div className="h-full flex items-center justify-center">
              <div className="w-full max-w-2xl">
                <SystemStatus jobs={jobs} />
              </div>
            </div>
          )}

          {currentPage === "account" && (
            <div className="h-full flex items-center justify-center">
              <div className="w-full max-w-2xl">
                <AccountPage />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function AccountPage() {
  // TODO: Replace with Clerk user data when Clerk is integrated
  // Example: const { user } = useUser() from @clerk/nextjs
  // const user = {
  //   id: user?.id || "RF-2847-X9K",
  //   email: user?.emailAddresses?.[0]?.emailAddress || "user@renderfarm.io",
  //   plan: user?.publicMetadata?.plan || "PRO_UNLIMITED",
  //   createdAt: user?.createdAt || new Date("2024-01-15"),
  // }

  // Placeholder data - ready for Clerk integration
  const user = {
    id: "RF-2847-X9K",
    email: "user@renderfarm.io",
    plan: "PRO_UNLIMITED",
    createdAt: new Date("2024-01-15"),
  }

  return (
    <div className="glass rounded-xl p-8">
      <h2 className="text-lg font-mono uppercase tracking-widest text-muted-foreground mb-8">Account Settings</h2>
      <div className="space-y-6">
        <div className="flex justify-between items-center glass-subtle rounded-lg px-4 py-3">
          <span className="text-sm font-mono text-muted-foreground">User ID</span>
          <span className="font-mono text-foreground">{user.id}</span>
        </div>
        <div className="flex justify-between items-center glass-subtle rounded-lg px-4 py-3">
          <span className="text-sm font-mono text-muted-foreground">Email</span>
          <span className="font-mono text-foreground">{user.email}</span>
        </div>
        <div className="flex justify-between items-center glass-subtle rounded-lg px-4 py-3">
          <span className="text-sm font-mono text-muted-foreground">Plan</span>
          <span className="font-mono text-primary">{user.plan}</span>
        </div>
        <div className="flex justify-between items-center glass-subtle rounded-lg px-4 py-3">
          <span className="text-sm font-mono text-muted-foreground">Member Since</span>
          <span className="font-mono text-foreground">
            {user.createdAt.toLocaleDateString("en-US", {
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
            })}
          </span>
        </div>
      </div>
    </div>
  )
}
