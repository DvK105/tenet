"use client"

import type React from "react"

import { useState, useRef } from "react"
import { Upload, File, X, ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"

interface UploadZoneProps {
  onUpload: (files: File[]) => void | Promise<void>
}

export function UploadZone({ onUpload }: UploadZoneProps) {
  const [dragActive, setDragActive] = useState(false)
  const [stagedFiles, setStagedFiles] = useState<File[]>([])
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const isBlendFile = (file: File) => file.name.toLowerCase().endsWith(".blend")

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true)
    } else if (e.type === "dragleave") {
      setDragActive(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      addFiles(Array.from(e.dataTransfer.files))
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault()
    if (e.target.files && e.target.files[0]) {
      addFiles(Array.from(e.target.files))
    }
  }

  const addFiles = (newFiles: File[]) => {
    const blendFiles = newFiles.filter(isBlendFile)
    if (blendFiles.length === 0) return
    setStagedFiles((prev) => [...prev, ...blendFiles])
  }

  const removeFile = (index: number) => {
    setStagedFiles((prev) => prev.filter((_, i) => i !== index))
  }

  const handleSubmit = async () => {
    if (submitting) return
    if (stagedFiles.length === 0) return
    try {
      setSubmitting(true)
      await onUpload(stagedFiles)
      setStagedFiles([])
    } finally {
      setSubmitting(false)
    }
  }

  const onButtonClick = () => {
    inputRef.current?.click()
  }

  return (
    <Card className="h-full glass rounded-xl relative overflow-hidden group flex flex-col">
      <div className="absolute top-0 left-0 w-1 h-full bg-primary/50 group-hover:bg-primary transition-colors rounded-l-xl" />

      <CardHeader className="pb-2 shrink-0">
        <CardTitle className="text-sm font-mono uppercase tracking-widest text-muted-foreground flex items-center justify-between">
          <span>01 / File Ingestion</span>
          <div className="flex gap-1">
            <div className="w-1 h-1 bg-primary rounded-full" />
            <div className="w-1 h-1 bg-primary/50 rounded-full" />
            <div className="w-1 h-1 bg-primary/20 rounded-full" />
          </div>
        </CardTitle>
      </CardHeader>

      <CardContent className="flex-1 min-h-0 flex flex-col gap-4">
        {stagedFiles.length === 0 ? (
          <div
            className={`
              relative border-2 border-dashed transition-all duration-300 flex-1 flex flex-col items-center justify-center min-h-[180px] rounded-lg
              ${dragActive ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-primary/50 hover:bg-muted/10"}
            `}
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
          >
            <input
              ref={inputRef}
              type="file"
              className="sr-only"
              multiple
              accept=".blend"
              onChange={handleChange}
            />

            <div className="flex flex-col items-center gap-4 z-10">
              <div
                className={`p-4 glass-subtle rounded-xl transition-transform duration-300 ${dragActive ? "scale-110" : ""}`}
              >
                <Upload className="w-6 h-6 text-foreground" />
              </div>
              <div className="text-center space-y-1">
                <p className="text-sm font-medium">DRAG_AND_DROP_FILES</p>
                <p className="text-xs font-mono text-muted-foreground">SUPPORTED: .BLEND</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={onButtonClick}
                className="rounded-lg border-primary text-primary hover:bg-primary hover:text-primary-foreground font-mono text-xs uppercase tracking-wider bg-transparent"
              >
                Select Files
              </Button>
            </div>

            {/* Technical markings */}
            <div className="absolute top-2 left-2 text-[10px] font-mono text-muted-foreground/40">TOP_L</div>
            <div className="absolute bottom-2 right-2 text-[10px] font-mono text-muted-foreground/40">BTM_R</div>
            <div className="absolute top-1/2 left-2 w-2 h-px bg-border" />
            <div className="absolute top-1/2 right-2 w-2 h-px bg-border" />
            <div className="absolute top-2 left-1/2 w-px h-2 bg-border" />
            <div className="absolute bottom-2 left-1/2 w-px h-2 bg-border" />
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-h-0">
            <ScrollArea className="flex-1 glass-subtle rounded-lg">
              <div className="p-2 space-y-2">
                {stagedFiles.map((file, i) => (
                  <div key={i} className="flex items-center justify-between p-2 glass rounded-lg group">
                    <div className="flex items-center gap-3 overflow-hidden">
                      <File className="w-4 h-4 text-primary shrink-0" />
                      <div className="flex flex-col min-w-0">
                        <span className="text-xs font-mono truncate">{file.name}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {(file.size / 1024 / 1024).toFixed(2)} MB
                        </span>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 rounded-md hover:text-destructive"
                      onClick={() => removeFile(i)}
                    >
                      <X className="w-3 h-3" />
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
            <div className="pt-4 flex gap-2">
              <Button
                variant="outline"
                className="flex-1 rounded-lg border-muted-foreground/30 bg-transparent"
                onClick={() => setStagedFiles([])}
                disabled={submitting}
              >
                CANCEL
              </Button>
              <Button
                className="flex-[2] rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 font-mono uppercase tracking-widest"
                onClick={handleSubmit}
                disabled={submitting}
              >
                INITIATE_RENDER <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
