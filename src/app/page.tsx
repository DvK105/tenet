"use client";

import { useState } from "react";

const RENDER_STATUS_MESSAGES = [
  "Rendering your scene…",
  "Preparing frames…",
  "Blender is working…",
  "Almost there…",
  "Hang tight…",
];

function formatSeconds(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<"idle" | "uploading" | "rendering" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [renderTimeSeconds, setRenderTimeSeconds] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<{
    elapsed_seconds?: number;
    frames_done?: number;
    total_frames?: number;
    eta_seconds?: number;
    blender_remaining?: string;
    blender_elapsed?: string;
    estimate_source?: string;
  } | null>(null);
  const [pollCount, setPollCount] = useState(0);
  const [lastCheckMs, setLastCheckMs] = useState<number | null>(null);
  const [lastStatus, setLastStatus] = useState<number | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<{
    estimated_time_seconds: number;
    estimated_time_formatted: string;
    complexity_score: number;
    total_frames: number;
    resolution: string;
    samples: number;
    engine: string;
    accuracy_score: number;
    accuracy_description: string;
  } | null>(null);
  const [estimating, setEstimating] = useState(false);

  async function getEstimate(file: File) {
    setEstimating(true);
    setEstimate(null);
    try {
      // Convert file to base64
      const fileBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          // Remove data URL prefix
          const base64 = result.split(',')[1];
          resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const response = await fetch("/api/estimate-render", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          blend_file_base64: fileBase64
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("Estimate API error:", response.status, errorText);
        throw new Error(`Failed to get estimate: ${response.status} ${errorText}`);
      }

      const estimateData = await response.json();
      setEstimate(estimateData);
    } catch (err) {
      console.error("Failed to get estimate:", err);
      // Don't show error to user, just don't show estimate
    } finally {
      setEstimating(false);
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setVideoUrl(null);
    setRenderTimeSeconds(null);
    setDownloading(false);
    setProgress(null);
    setPollCount(0);
    setLastCheckMs(null);
    setLastStatus(null);
    setStatusMessage(null);

    if (!file) {
      setError("Please select a .blend file first.");
      return;
    }

    try {
      // 1) Upload the .blend file
      setStatus("uploading");
      const formData = new FormData();
      formData.append("file", file);

      const uploadRes = await fetch("/api/upload-blend", {
        method: "POST",
        body: formData,
      });

      if (!uploadRes.ok) {
        const body = await uploadRes.json().catch(() => ({}));
        throw new Error(body.error ?? "Upload failed");
      }

      const uploadData: { callId: string } = await uploadRes.json();
      if (!uploadData.callId) {
        throw new Error("Upload did not return callId");
      }

      // 2) Poll render status until done
      setStatus("rendering");
      const startedAt = Date.now();
      const maxWaitMs = 30 * 60 * 1000; // 30 minutes
      let poll = 0;

      while (true) {
        if (Date.now() - startedAt > maxWaitMs) {
          throw new Error("Render timed out");
        }

        poll += 1;
        const pollStart = Date.now();
        const statusRes = await fetch(`/api/render-status?callId=${encodeURIComponent(uploadData.callId)}`);
        const checkMs = Math.round(Date.now() - pollStart);

        setPollCount(poll);
        setLastCheckMs(checkMs);
        setLastStatus(statusRes.status);
        if (poll % 5 === 0) {
          setStatusMessage(RENDER_STATUS_MESSAGES[(poll / 5 - 1) % RENDER_STATUS_MESSAGES.length]);
        }

        if (!statusRes.ok) {
          const body = await statusRes.json().catch(() => ({}));
          throw new Error(body.error ?? "Failed to fetch render status");
        }

        const statusData: {
          status?: string;
          url?: string;
          error?: string;
          render_time_seconds?: number;
          progress?: {
            elapsed_seconds?: number;
            frames_done?: number;
            total_frames?: number;
            eta_seconds?: number;
            blender_remaining?: string;
            blender_elapsed?: string;
            estimate_source?: string;
          };
        } = await statusRes.json();

        if (statusData.progress) {
          setProgress(statusData.progress);
        }

        if (statusData.status === "done") {
          if (!statusData.url) {
            throw new Error("Render completed but no URL was returned");
          }
          setVideoUrl(statusData.url);
          if (typeof statusData.render_time_seconds === "number") {
            setRenderTimeSeconds(statusData.render_time_seconds);
          }
          setStatus("done");
          break;
        }

        if (statusData.status === "error") {
          throw new Error(statusData.error ?? "Render failed");
        }

        await new Promise((r) => setTimeout(r, 2000));
      }
      setProgress(null);
      setStatusMessage(null);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Something went wrong during upload/render.";
      setError(message);
      setStatus("error");
    }
  }

  async function handleDownload() {
    if (!videoUrl) return;
    setDownloading(true);
    try {
      const res = await fetch("/api/download-render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: videoUrl }),
      });
      if (!res.ok) throw new Error("Download failed");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "rendered-video.mp4";
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background text-foreground">
      <div className="w-full max-w-xl space-y-6 rounded-xl border border-border bg-card p-6 shadow-md">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Blend renderer</h1>
          <p className="text-sm text-muted-foreground">
            Upload a <code>.blend</code> file, then we&apos;ll send it to Modal
            to render using the scene&apos;s own settings.
          </p>
        </div>
        <form
          className="space-y-4"
          onSubmit={handleSubmit}
          encType="multipart/form-data"
        >
          <input
            type="file"
            accept=".blend"
            className="block w-full text-sm text-muted-foreground file:mr-4 file:rounded-md file:border-0 file:bg-primary file:px-4 file:py-2 file:text-sm file:font-medium file:text-primary-foreground hover:file:bg-primary/90"
            onChange={(event) => {
              const selected = event.target.files?.[0] ?? null;
              
              if (selected) {
                // Validate file extension
                if (!selected.name.toLowerCase().endsWith('.blend')) {
                  setError("Please select a file with .blend extension");
                  setFile(null);
                  return;
                }
                
                // Validate file size (max 100MB)
                if (selected.size > 100 * 1024 * 1024) {
                  setError("File size must be less than 100MB");
                  setFile(null);
                  return;
                }
              }
              
              setFile(selected);
              setVideoUrl(null);
              setError(null);
              setStatus("idle");
              setEstimate(null);
              
              // Get estimate for the selected file
              if (selected) {
                getEstimate(selected);
              }
            }}
          />
          <button
            type="submit"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            {status === "uploading"
              ? "Uploading..."
              : status === "rendering"
                ? "Rendering..."
                : "Upload & render"}
          </button>
          
          {/* Estimate Display */}
          {estimating && (
            <div className="space-y-1.5 rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
              <p>Calculating render estimate...</p>
            </div>
          )}
          
          {estimate && !estimating && status === "idle" && (
            <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium text-foreground">Estimated render time:</span>
                <span className="text-foreground">{estimate.estimated_time_formatted}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Accuracy:</span>
                <span className="text-muted-foreground text-xs">{estimate.accuracy_description}</span>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <div>Frames: {estimate.total_frames}</div>
                <div>Resolution: {estimate.resolution}</div>
                <div>Samples: {estimate.samples}</div>
                <div>Engine: {estimate.engine}</div>
              </div>
            </div>
          )}
          
          {status === "rendering" && (
            <div className="space-y-1.5 rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
              <p>
                Checking status… (poll #{pollCount})
                {lastStatus != null && lastCheckMs != null && (
                  <> · Last: {lastStatus} in {lastCheckMs}ms</>
                )}
              </p>
              {statusMessage && (
                <p className="font-medium text-foreground">{statusMessage}</p>
              )}
              {progress && (
                <p>
                  {progress.frames_done != null &&
                  progress.total_frames != null &&
                  progress.total_frames > 0 ? (
                    <>
                      Frame {progress.frames_done}/{progress.total_frames}
                      {progress.total_frames - progress.frames_done > 0 && (
                        <> · {progress.total_frames - progress.frames_done} frames left</>
                      )}
                    </>
                  ) : (
                    <>Elapsed: {formatSeconds(progress.elapsed_seconds ?? 0)}</>
                  )}
                  
                  {/* Show Blender's own time estimation if available */}
                  {progress.blender_remaining && (
                    <> · Blender ETA: {progress.blender_remaining}</>
                  )}
                  {progress.blender_elapsed && (
                    <> · Blender Time: {progress.blender_elapsed}</>
                  )}
                  
                  {/* Show calculated ETA as fallback */}
                  {!progress.blender_remaining && progress.eta_seconds != null && progress.eta_seconds > 0 && (
                    <> · ~{formatSeconds(progress.eta_seconds)} left</>
                  )}
                  
                  {/* Show source of time estimation */}
                  {progress.estimate_source && (
                    <span className="text-xs text-muted-foreground ml-1">
                      ({progress.estimate_source})
                    </span>
                  )}
                </p>
              )}
              {estimate && (
                <div className="text-xs text-muted-foreground border-t pt-2 mt-2">
                  Original estimate: {estimate.estimated_time_formatted} 
                  <span className="ml-2">
                    ({estimate.accuracy_description.toLowerCase()})
                  </span>
                </div>
              )}
            </div>
          )}
        </form>
        {error && (
          <p className="text-sm text-red-500">
            {error}
          </p>
        )}
        {videoUrl && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Blender render time:{" "}
              <span className="font-medium text-foreground">
                {renderTimeSeconds != null ? (
                  renderTimeSeconds < 60
                    ? `${renderTimeSeconds.toFixed(1)}s`
                    : `${Math.floor(renderTimeSeconds / 60)}m ${(renderTimeSeconds % 60).toFixed(0)}s`
                ) : (
                  "—"
                )}
              </span>
            </p>
            <p className="text-sm text-muted-foreground">Rendered video:</p>
            <video
              className="w-full rounded-lg border border-border"
              controls
              src={videoUrl}
            />
            <button
              type="button"
              onClick={handleDownload}
              disabled={downloading}
              className="inline-flex items-center justify-center rounded-md border border-border bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground hover:bg-secondary/80 disabled:opacity-50"
            >
              {downloading ? "Downloading..." : "Download video"}
            </button>
          </div>
        )}
      </div>
    </main>
  );
}
