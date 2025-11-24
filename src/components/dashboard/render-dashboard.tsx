"use client"

import { useState } from "react"
import { Sidebar } from "@/components/dashboard/sidebar"
import { Header } from "@/components/dashboard/header"
import { UploadZone } from "@/components/dashboard/upload-zone"
import { RenderQueue } from "@/components/dashboard/render-queue"
import { PerformanceGraph } from "@/components/dashboard/performance-graph"
import { SystemStatus } from "@/components/dashboard/system-status"

export function RenderDashboard() {
  const [files, setFiles] = useState<File[]>([])
  const [currentPage, setCurrentPage] = useState<"upload" | "graph" | "status" | "account">("upload")

  const handleUpload = (newFiles: File[]) => {
    setFiles((prev) => [...prev, ...newFiles])
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
              <RenderQueue files={files} />
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
