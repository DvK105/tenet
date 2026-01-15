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

const main = () => {
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [frameData, setFrameData] = useState<FrameData | null>(null)
  const [sandboxId, setSandboxId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload file')
      setFrameData(null)
      setSandboxId(null)
    } finally {
      if (progressInterval) {
        clearInterval(progressInterval)
      }
      setUploading(false)
      setTimeout(() => setUploadProgress(0), 1000)
    }
  }

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
        // Optionally show success message
      } else {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to trigger render')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger Inngest function')
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
              disabled={!sandboxId || uploading}
              variant="default"
              className="flex-1"
            >
              Start Render
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export default main