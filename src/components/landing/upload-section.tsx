"use client"

import type React from "react"

import { useState, useCallback } from "react"
import { Upload, File, X, CheckCircle2, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { useRouter } from "next/navigation"

interface UploadedFile {
  id: string
  name: string
  size: number
  progress: number
  status: "uploading" | "complete" | "error"
}

export function UploadSection() {
  const [isDragging, setIsDragging] = useState(false)
  const [files, setFiles] = useState<UploadedFile[]>([])
  const router = useRouter()

  const handleDrag = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === "dragenter" || e.type === "dragover") {
      setIsDragging(true)
    } else if (e.type === "dragleave") {
      setIsDragging(false)
    }
  }, [])

  const simulateUpload = (file: File) => {
    const id = Math.random().toString(36).substr(2, 9)
    const newFile: UploadedFile = {
      id,
      name: file.name,
      size: file.size,
      progress: 0,
      status: "uploading",
    }

    setFiles((prev) => [...prev, newFile])

    // Simulate upload progress
    let progress = 0
    const interval = setInterval(() => {
      progress += Math.random() * 15
      if (progress >= 100) {
        progress = 100
        clearInterval(interval)
        setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, progress: 100, status: "complete" } : f)))
      } else {
        setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, progress } : f)))
      }
    }, 200)
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)

    const droppedFiles = Array.from(e.dataTransfer.files)
    droppedFiles.forEach(simulateUpload)
  }, [])

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      Array.from(e.target.files).forEach(simulateUpload)
    }
  }

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id))
  }

  const formatSize = (bytes: number) => {
    if (bytes === 0) return "0 B"
    const k = 1024
    const sizes = ["B", "KB", "MB", "GB"]
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Number.parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i]
  }

  return (
    <section id="upload" className="relative py-32 px-6">
      <div className="max-w-4xl mx-auto">
        {/* Section header */}
        <div className="text-center mb-16">
          <span className="font-mono text-xs tracking-[0.3em] text-primary uppercase">Step 01</span>
          <h2 className="mt-4 text-4xl md:text-5xl font-light text-foreground tracking-tight">Upload Your Files</h2>
          <p className="mt-4 text-muted-foreground max-w-lg mx-auto">
            Drag and drop your project files. We support all major 3D formats including .blend, .max, .c4d, .ma, and
            more.
          </p>
        </div>

        {/* Upload zone */}
        <div
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
          className={cn(
            "relative group cursor-pointer transition-all duration-500",
            "border-2 border-dashed rounded-sm p-16",
            isDragging
              ? "border-primary bg-primary/5 shadow-[0_0_60px_rgba(0,200,200,0.15)]"
              : "border-border hover:border-primary/50 hover:bg-card/50",
          )}
        >
          <input
            type="file"
            multiple
            accept=".blend,.fbx,.obj,.stl,.gltf,.glb,.c4d,.ma,.mb,.hip"
            onChange={handleFileInput}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />

          <div className="flex flex-col items-center text-center">
            <div
              className={cn(
                "w-20 h-20 border flex items-center justify-center transition-all duration-500",
                isDragging ? "border-primary bg-primary/10 glow-pulse" : "border-border group-hover:border-primary",
              )}
            >
              <Upload
                className={cn(
                  "w-8 h-8 transition-all duration-500",
                  isDragging ? "text-primary scale-110" : "text-muted-foreground group-hover:text-primary",
                )}
              />
            </div>

            <p className="mt-6 font-mono text-sm text-foreground">
              {isDragging ? "Release to upload" : "Drop files here or click to browse"}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">.blend, .max, .c4d, .ma, .mb, .fbx, .obj — up to 10GB</p>
          </div>

          {/* Corner accents */}
          <div className="absolute top-4 left-4 w-4 h-4 border-l border-t border-primary/30" />
          <div className="absolute top-4 right-4 w-4 h-4 border-r border-t border-primary/30" />
          <div className="absolute bottom-4 left-4 w-4 h-4 border-l border-b border-primary/30" />
          <div className="absolute bottom-4 right-4 w-4 h-4 border-r border-b border-primary/30" />
        </div>

        {/* File list */}
        {files.length > 0 && (
          <div className="mt-8 space-y-3">
            {files.map((file) => (
              <div
                key={file.id}
                className="relative bg-card border border-border p-4 flex items-center gap-4 group hover:border-primary/50 transition-all duration-300"
              >
                {/* File icon */}
                <div className="w-10 h-10 border border-border flex items-center justify-center shrink-0">
                  <File className="w-5 h-5 text-muted-foreground" />
                </div>

                {/* File info */}
                <div className="flex-1 min-w-0">
                  <p className="font-mono text-sm text-foreground truncate">{file.name}</p>
                  <p className="text-xs text-muted-foreground">{formatSize(file.size)}</p>
                </div>

                {/* Status */}
                <div className="flex items-center gap-3">
                  {file.status === "uploading" && (
                    <>
                      <span className="font-mono text-xs text-primary">{Math.round(file.progress)}%</span>
                      <Loader2 className="w-5 h-5 text-primary animate-spin" />
                    </>
                  )}
                  {file.status === "complete" && <CheckCircle2 className="w-5 h-5 text-primary" />}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => removeFile(file.id)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity duration-300"
                  >
                    <X className="w-5 h-5 text-muted-foreground hover:text-destructive" />
                  </Button>
                </div>

                {/* Progress bar */}
                {file.status === "uploading" && (
                  <div className="absolute bottom-0 left-0 right-0 h-px bg-border">
                    <div
                      className="h-full bg-primary transition-all duration-300"
                      style={{ width: `${file.progress}%` }}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Render button */}
        {files.some((f) => f.status === "complete") && (
          <Button
            onClick={() => router.push("/dashboard")}
            className="mt-8 w-full font-mono text-sm tracking-wide py-4 hover:shadow-[0_0_40px_rgba(0,200,200,0.3)]"
          >
            Start Rendering →
          </Button>
        )}
      </div>
    </section>
  )
}
