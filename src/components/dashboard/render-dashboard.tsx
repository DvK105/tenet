"use client"

import { useState } from "react"
import { Sidebar } from "@/components/dashboard/sidebar"
import { Header } from "@/components/dashboard/header"
import { UploadZone } from "@/components/dashboard/upload-zone"
import { RenderQueue } from "@/components/dashboard/render-queue"
import { PerformanceGraph } from "@/components/dashboard/performance-graph"
import { SystemStatus } from "@/components/dashboard/system-status"
import type { Job } from "@/types/job"

export function RenderDashboard() {
  const [files, setFiles] = useState<File[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [currentPage, setCurrentPage] = useState<"upload" | "graph" | "status" | "account">("upload")

  const handleUpload = (newFiles: File[]) => {
    setFiles((prev) => [...prev, ...newFiles])
    // Optimistically add to queue and POST to /api/upload which triggers Inngest
    newFiles.forEach(async (file) => {
      const tempId = `LOCAL-${(
        globalThis.crypto?.randomUUID?.() ??
        (globalThis.crypto
          ? Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)))
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("")
          : Math.random().toString(36).slice(2))
      )}`
      setJobs((prev) => [
        ...prev,
        {
          id: tempId,
          name: file.name,
          status: "queued",
          progress: 0,
          frames: "-",
          time: "--:--:--",
        },
      ])

      try {
        const fd = new FormData()
        fd.append("blend", file)
        const res = await fetch("/api/upload", { method: "POST", body: fd })
        const json = await res.json()
        if (res.ok && json?.id) {
          // Replace temp id with server id
          setJobs((prev) =>
            prev.map((j) => (j.id === tempId ? { ...j, id: json.id } : j))
          )
        } else {
          throw new Error(json?.error || "Upload failed")
        }
      } catch (e) {
        setJobs((prev) => prev.map((j) => (j.id === tempId ? { ...j, status: "error" } : j)))
      }
    })
  }

  const handlePause = (id: string) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, status: "paused" } : j)))
  }

  const handleCancel = (id: string) => {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, status: "canceled", progress: 0 } : j)))
  }

  return (
    <div className="flex h-screen w-full bg-background text-foreground">
      <Sidebar currentPage={currentPage} onPageChange={setCurrentPage} />
      <div className="flex-1 flex flex-col min-w-0 relative z-0">
        <Header />

        {/* <div className="absolute top-20 right-6 z-30">
          <CreditsWidget />
        </div> */}

        <div className="flex-1 p-6 bg-grid-pattern overflow-hidden">
          {currentPage === "upload" && (
            <div className="h-full grid grid-rows-2 gap-6">
              <UploadZone onUpload={handleUpload} />
              <RenderQueue files={files} jobs={jobs} onPause={handlePause} onCancel={handleCancel} />
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
    <div className="border border-border bg-card rounded-none p-8">
      <h2 className="text-lg font-mono uppercase tracking-widest text-muted-foreground mb-8">Account Settings</h2>
      <div className="space-y-6">
        <div className="flex justify-between items-center border-b border-border pb-4">
          <span className="text-sm font-mono text-muted-foreground">User ID</span>
          <span className="font-mono text-foreground">RF-2847-X9K</span>
        </div>
        <div className="flex justify-between items-center border-b border-border pb-4">
          <span className="text-sm font-mono text-muted-foreground">Email</span>
          <span className="font-mono text-foreground">user@renderfarm.io</span>
        </div>
        <div className="flex justify-between items-center border-b border-border pb-4">
          <span className="text-sm font-mono text-muted-foreground">Plan</span>
          <span className="font-mono text-primary">PRO_UNLIMITED</span>
        </div>
        <div className="flex justify-between items-center border-b border-border pb-4">
          <span className="text-sm font-mono text-muted-foreground">Member Since</span>
          <span className="font-mono text-foreground">2024.01.15</span>
        </div>
      </div>
    </div>
  )
}
