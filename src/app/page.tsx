'use client'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import React, { useState, useRef, useEffect } from 'react'

interface FrameData {
  frameStart: number
  frameEnd: number
  frameCount: number
  fps: number
}

type RenderStatus = 'idle' | 'queued' | 'rendering' | 'completed' | 'error'

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h > 0) return `${h}h ${m}m ${r}s`
  if (m > 0) return `${m}m ${r}s`
  return `${r}s`
}

function formatHours(seconds: number): string {
  const hours = Math.max(0, seconds) / 3600
  return `${hours.toFixed(2)}h`
}

const main = () => {
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [frameData, setFrameData] = useState<FrameData | null>(null)
  const [sandboxId, setSandboxId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [renderStatus, setRenderStatus] = useState<RenderStatus>('idle')
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [renderProgress, setRenderProgress] = useState<number | null>(null)
  const [renderEtaSeconds, setRenderEtaSeconds] = useState<number | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0]

    // No file selected (e.g. user cleared the input)
    if (!selectedFile) {
      setFile(null)
      setError(null)
      return
    }

    // Invalid extension: clear current file and reset input so state matches UI
    if (!selectedFile.name.toLowerCase().endsWith('.blend')) {
      setError('Please select a .blend file')
      setFile(null)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
      return
    }

    // Valid file: clear any previous error and update file state
    setError(null)
    setFile(selectedFile)
    setFrameData(null)
    setSandboxId(null)
    setRenderStatus('idle')
    setVideoUrl(null)
    setRenderProgress(null)
    setRenderEtaSeconds(null)
  }

  const handleUpload = async () => {
    if (!file) {
      setError('Please select a file first')
      return
    }

    setUploading(true)
    setUploadProgress(0)
    setError(null)

    let progressInterval: NodeJS.Timeout | null = null

    try {
      const formData = new FormData()
      formData.append('file', file)

      // Simulate progress with proper cleanup
      progressInterval = setInterval(() => {
        setUploadProgress((prev) => {
          if (prev >= 90) {
            if (progressInterval) {
              clearInterval(progressInterval)
            }
            return 90
          }
          return prev + 10
        })
      }, 200)

      const response = await fetch('/api/upload-blender', {
        method: 'POST',
        body: formData,
      })

      if (progressInterval) {
        clearInterval(progressInterval)
        progressInterval = null
      }
      setUploadProgress(100)

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Upload failed')
      }

      const data = await response.json()
      setFrameData(data.frameData)
      setSandboxId(data.sandboxId)
      // Auto-triggered render starts automatically, set status to queued
      setRenderStatus('queued')
      setVideoUrl(null)
      setRenderProgress(0)
      setRenderEtaSeconds(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload file')
      setFrameData(null)
      setSandboxId(null)
      setRenderStatus('idle')
      setVideoUrl(null)
      setRenderProgress(null)
      setRenderEtaSeconds(null)
    } finally {
      if (progressInterval) {
        clearInterval(progressInterval)
      }
      setUploading(false)
      setTimeout(() => setUploadProgress(0), 1000)
    }
  }

  // Poll render status when sandboxId is available and render is in progress
  useEffect(() => {
    if (!sandboxId || renderStatus === 'completed' || renderStatus === 'error' || renderStatus === 'idle') {
      return
    }

    const pollInterval = setInterval(async () => {
      try {
        const response = await fetch(`/api/render-status?sandboxId=${sandboxId}`)
        if (response.ok) {
          const data: {
            status?: RenderStatus
            videoUrl?: string
            progress?: number
            etaSeconds?: number
          } = await response.json()

          if (typeof data.progress === 'number' && Number.isFinite(data.progress)) {
            setRenderProgress(data.progress)
          }

          if (typeof data.etaSeconds === 'number' && Number.isFinite(data.etaSeconds)) {
            setRenderEtaSeconds(data.etaSeconds)
          }

          if (data.status === 'completed') {
            setRenderStatus('completed')
            setVideoUrl(data.videoUrl ?? null)
            clearInterval(pollInterval)
          } else if (data.status === 'rendering') {
            setRenderStatus('rendering')
          }
        }
      } catch (err) {
        console.error('Error polling render status:', err)
        // Don't set error state, just log it and continue polling
      }
    }, 3000) // Poll every 3 seconds

    return () => {
      clearInterval(pollInterval)
    }
  }, [sandboxId, renderStatus])

  // Cleanup progress interval on unmount
  useEffect(() => {
    return () => {
      // This cleanup ensures no interval leaks if component unmounts during upload
    }
  }, [])

  const handleTriggerRender = async () => {
    if (!sandboxId) {
      setError('Please upload a Blender file first')
      return
    }

    setRenderStatus('queued')
    setVideoUrl(null)
    setError(null)
    setRenderProgress(0)
    setRenderEtaSeconds(null)

    try {
      const response = await fetch('/api/trigger-render', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sandboxId }),
      })

      if (response.ok) {
        console.log('Inngest function triggered successfully')
        setRenderStatus('rendering')
      } else {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to trigger render')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger Inngest function')
      setRenderStatus('error')
    }
  }

  return (
    <div className="container mx-auto p-8 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>Blender File Upload</CardTitle>
          <CardDescription>
            Upload a Blender (.blend) file to analyze frame count before rendering
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Input
              ref={fileInputRef}
              type="file"
              accept=".blend"
              onChange={handleFileChange}
              disabled={uploading}
            />
            {file && (
              <p className="text-sm text-muted-foreground">
                Selected: {file.name} ({(file.size / 1024 / 1024).toFixed(2)} MB)
              </p>
            )}
          </div>

          {uploading && (
            <div className="space-y-2">
              <Progress value={uploadProgress} />
              <p className="text-sm text-muted-foreground text-center">
                Uploading and analyzing file...
              </p>
            </div>
          )}

          {error && (
            <div className="p-3 bg-destructive/10 border border-destructive/20 rounded-md">
              <p className="text-sm text-destructive">{error}</p>
            </div>
          )}

          {frameData && (
            <Card className="bg-muted/50">
              <CardHeader>
                <CardTitle className="text-lg">Frame Analysis</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm text-muted-foreground">Frame Start</p>
                    <p className="text-lg font-semibold">{frameData.frameStart}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Frame End</p>
                    <p className="text-lg font-semibold">{frameData.frameEnd}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Total Frames</p>
                    <p className="text-lg font-semibold">{frameData.frameCount}</p>
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">FPS</p>
                    <p className="text-lg font-semibold">{frameData.fps}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {renderStatus !== 'idle' && (
            <Card className="bg-muted/50">
              <CardHeader>
                <CardTitle className="text-lg">Render Status</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Status:</span>
                    <span className={`text-sm font-semibold ${
                      renderStatus === 'completed' ? 'text-green-600' :
                      renderStatus === 'error' ? 'text-red-600' :
                      renderStatus === 'rendering' ? 'text-blue-600' :
                      'text-yellow-600'
                    }`}>
                      {renderStatus === 'queued' && 'Queued'}
                      {renderStatus === 'rendering' && 'Rendering...'}
                      {renderStatus === 'completed' && 'Completed'}
                      {renderStatus === 'error' && 'Error'}
                    </span>
                  </div>
                  {(renderStatus === 'rendering' || renderStatus === 'queued') && (
                    <Progress value={renderProgress ?? (renderStatus === 'queued' ? 0 : 0)} />
                  )}
                  {(renderStatus === 'rendering' || renderStatus === 'queued') && (
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">ETA:</span>
                      <span className="text-sm font-semibold">
                        {renderEtaSeconds !== null ? formatDuration(renderEtaSeconds) : 'Calculating...'}
                      </span>
                    </div>
                  )}
                  {(renderStatus === 'rendering' || renderStatus === 'queued') && (
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">ETA (hours):</span>
                      <span className="text-sm font-semibold">
                        {renderEtaSeconds !== null ? formatHours(renderEtaSeconds) : 'Calculating...'}
                      </span>
                    </div>
                  )}
                </div>
                {renderStatus === 'completed' && videoUrl && (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">Your video is ready!</p>
                    <div className="flex gap-2">
                      <Button asChild>
                        <a href={videoUrl} download target="_blank" rel="noopener noreferrer">
                          Download MP4
                        </a>
                      </Button>
                      <Button variant="outline" asChild>
                        <a href={videoUrl} target="_blank" rel="noopener noreferrer">
                          Preview
                        </a>
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <div className="flex gap-2">
            <Button
              onClick={handleUpload}
              disabled={!file || uploading}
              className="flex-1"
            >
              {uploading ? 'Uploading...' : 'Upload & Analyze'}
            </Button>
            <Button
              onClick={handleTriggerRender}
              disabled={!sandboxId || uploading || renderStatus === 'rendering'}
              variant="default"
              className="flex-1"
            >
              {renderStatus === 'rendering' ? 'Rendering...' : 'Re-render'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export default main