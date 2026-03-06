"use client";

import { useState } from "react";

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<"idle" | "uploading" | "rendering" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setVideoUrl(null);

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

      while (true) {
        if (Date.now() - startedAt > maxWaitMs) {
          throw new Error("Render timed out");
        }

        const statusRes = await fetch(`/api/render-status?callId=${encodeURIComponent(uploadData.callId)}`);
        if (!statusRes.ok) {
          const body = await statusRes.json().catch(() => ({}));
          throw new Error(body.error ?? "Failed to fetch render status");
        }

        const statusData: { status?: string; url?: string; error?: string } = await statusRes.json();

        if (statusData.status === "done") {
          if (!statusData.url) {
            throw new Error("Render completed but no URL was returned");
          }
          setVideoUrl(statusData.url);
          setStatus("done");
          break;
        }

        if (statusData.status === "error") {
          throw new Error(statusData.error ?? "Render failed");
        }

        await new Promise((r) => setTimeout(r, 2000));
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Something went wrong during upload/render.";
      setError(message);
      setStatus("error");
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
        </form>
        {error && (
          <p className="text-sm text-red-500">
            {error}
          </p>
        )}
        {videoUrl && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Rendered video:</p>
            <video
              className="w-full rounded-lg border border-border"
              controls
              src={videoUrl}
            />
          </div>
        )}
      </div>
    </main>
  );
}
