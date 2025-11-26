"use client"

import React, { useState } from "react"
import { Sidebar } from "@/components/dash/sidebar"
import { Header } from "@/components/dash/header"
import { UploadZone } from "@/components/dash/upload-zone"
import { RenderQueue } from "@/components/dash/render-queue"
import { PerformanceGraph } from "@/components/dash/performance-graph"
import { SystemStatus } from "@/components/dash/system-status"

export function RenderDashboard() {
  const [files, setFiles] = useState<File[]>([])

  const handleUpload = (newFiles: File[]) => {
    setFiles((prev) => [...prev, ...newFiles])
  }

  return (
    <div className="flex h-screen w-full bg-background text-foreground">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0 relative z-0">
        <Header />
        <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-grid-pattern">
          
          {/* Top Row: Upload and Status - Equal height row */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 h-[400px] lg:h-[350px]">
            <div className="lg:col-span-8 h-full">
              <UploadZone onUpload={handleUpload} />
            </div>
            <div className="lg:col-span-4 h-full">
              <SystemStatus />
            </div>
          </div>

          {/* Middle Row: Graph */}
          <div className="w-full">
            <PerformanceGraph />
          </div>

          {/* Bottom Row: Queue */}
          <div className="w-full">
            <RenderQueue files={files} />
          </div>
          
        </div>
      </div>
    </div>
  )
}
