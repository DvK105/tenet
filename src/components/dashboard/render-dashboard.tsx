"use client"

import { useState } from "react"
import { Sidebar } from "@/components/dashboard/sidebar"
import { Header } from "@/components/dashboard/header"
import { UploadZone } from "@/components/dashboard/upload-zone"
import { RenderQueue } from "@/components/dashboard/render-queue"
import { PerformanceGraph } from "@/components/dashboard/performance-graph"
import { SystemStatus } from "@/components/dashboard/system-status"
import { getSupabaseBrowserClient, getSupabaseInputsBucket } from "@/lib/supabase-browser"
import { retryFetch } from "@/lib/retry"
import { toast } from "sonner"
import { useRenderJobs } from "@/hooks/use-render-jobs"
import { useRenderStatus } from "@/hooks/use-render-status"
import type { RenderJob, RenderStatus } from "@/types"

export function RenderDashboard() {
  const [currentPage, setCurrentPage] = useState<"upload" | "graph" | "status" | "account">("upload")
  
  const { jobs, addJob, updateJob, clearJobs } = useRenderJobs()

  // Handle status updates from SSE/polling
  const handleStatusUpdate = (jobId: string, status: RenderStatus) => {
    const nextStatus: RenderJob["status"] =
      status.status === "completed"
        ? "completed"
        : status.status === "error"
          ? "error"
          : "rendering"

    updateJob(jobId, {
      status: nextStatus,
      progress: status.progress,
      etaSeconds: status.etaSeconds,
      videoUrl: status.videoUrl,
      errorMessage: status.errorMessage,
      fileSize: status.fileSize,
      completedAt: nextStatus === "completed" ? Date.now() : undefined,
    })
  }

  // Use render status hook for SSE/polling
  const { refreshStatus } = useRenderStatus({
    jobs,
    onStatusUpdate: handleStatusUpdate,
  })

  const handleUpload = async (newFiles: File[]) => {
    await Promise.all(
      newFiles.map(async (file) => {
        const renderId = crypto.randomUUID()
        addJob({
          id: renderId,
          fileName: file.name,
          createdAt: Date.now(),
          status: "uploading",
          progress: 0,
        })

        try {
          const supabase = getSupabaseBrowserClient()
          if (!supabase) {
            // Supabase not configured, skip upload and continue without toast
            updateJob(renderId, { status: "error", errorMessage: "Supabase not configured" })
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
            updateJob(renderId, { status: "error", errorMessage: msg })
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
            updateJob(renderId, { status: "error", errorMessage: msg })
            return
          }

          updateJob(renderId, { status: "rendering", errorMessage: undefined })
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          // Suppress toasts for Supabase URL configuration errors
          if (!msg.includes("NEXT_PUBLIC_SUPABASE_URL") && !msg.includes("NEXT_PUBLIC_SUPABASE_ANON_KEY")) {
            toast.error(msg)
          }
          updateJob(renderId, { status: "error", errorMessage: msg })
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
                onRefresh={refreshStatus}
                onClear={clearJobs}
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
