"use client"

import { useEffect, useMemo, useState } from "react"
import { Sidebar } from "@/components/dashboard/sidebar"
import { Header } from "@/components/dashboard/header"
import { UploadZone } from "@/components/dashboard/upload-zone"
import { RenderQueue } from "@/components/dashboard/render-queue"
import { PerformanceGraph } from "@/components/dashboard/performance-graph"
import { SystemStatus } from "@/components/dashboard/system-status"

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
  status: "uploading" | "rendering" | "completed" | "error"
  progress?: number
  etaSeconds?: number
  videoUrl?: string
}

export function RenderDashboard() {
  const [jobs, setJobs] = useState<RenderJob[]>([])
  const [currentPage, setCurrentPage] = useState<"upload" | "graph" | "status" | "account">("upload")

  const pollingTargets = useMemo(() => jobs.filter((j) => j.status === "rendering"), [jobs])

  useEffect(() => {
    if (pollingTargets.length === 0) return

    const interval = window.setInterval(async () => {
      await Promise.all(
        pollingTargets.map(async (job) => {
          try {
            const res = await fetch(`/api/render-status?sandboxId=${encodeURIComponent(job.id)}`, {
              cache: "no-store",
            })
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
            // ignore polling errors
          }
        })
      )
    }, 2000)

    return () => window.clearInterval(interval)
  }, [pollingTargets])

  const refreshRenderingJobs = async () => {
    const targets = jobs.filter((j) => j.status === "rendering")
    if (targets.length === 0) return

    await Promise.all(
      targets.map(async (job) => {
        try {
          const res = await fetch(`/api/render-status?sandboxId=${encodeURIComponent(job.id)}`, {
            cache: "no-store",
          })
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
        const tempId = `LOCAL-${crypto.randomUUID()}`
        setJobs((prev) => [
          {
            id: tempId,
            fileName: file.name,
            createdAt: Date.now(),
            status: "uploading",
            progress: 0,
          },
          ...prev,
        ])

        try {
          const form = new FormData()
          form.append("file", file)

          const res = await fetch("/api/upload-blender", {
            method: "POST",
            body: form,
          })

          const data = (await res.json()) as { sandboxId?: string; success?: boolean; error?: string }
          if (!res.ok || !data?.sandboxId) {
            setJobs((prev) =>
              prev.map((j) => (j.id === tempId ? { ...j, status: "error" } : j))
            )
            return
          }

          setJobs((prev) =>
            prev.map((j) =>
              j.id === tempId
                ? {
                    ...j,
                    id: data.sandboxId as string,
                    status: "rendering",
                  }
                : j
            )
          )
        } catch {
          setJobs((prev) => prev.map((j) => (j.id === tempId ? { ...j, status: "error" } : j)))
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
              <PerformanceGraph />
            </div>
          )}

          {currentPage === "status" && (
            <div className="h-full flex items-center justify-center">
              <div className="w-full max-w-2xl">
                <SystemStatus />
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
  return (
    <div className="glass rounded-xl p-8">
      <h2 className="text-lg font-mono uppercase tracking-widest text-muted-foreground mb-8">Account Settings</h2>
      <div className="space-y-6">
        <div className="flex justify-between items-center glass-subtle rounded-lg px-4 py-3">
          <span className="text-sm font-mono text-muted-foreground">User ID</span>
          <span className="font-mono text-foreground">RF-2847-X9K</span>
        </div>
        <div className="flex justify-between items-center glass-subtle rounded-lg px-4 py-3">
          <span className="text-sm font-mono text-muted-foreground">Email</span>
          <span className="font-mono text-foreground">user@renderfarm.io</span>
        </div>
        <div className="flex justify-between items-center glass-subtle rounded-lg px-4 py-3">
          <span className="text-sm font-mono text-muted-foreground">Plan</span>
          <span className="font-mono text-primary">PRO_UNLIMITED</span>
        </div>
        <div className="flex justify-between items-center glass-subtle rounded-lg px-4 py-3">
          <span className="text-sm font-mono text-muted-foreground">Member Since</span>
          <span className="font-mono text-foreground">2024.01.15</span>
        </div>
      </div>
    </div>
  )
}
