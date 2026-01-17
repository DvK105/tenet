/**
 * Hook for managing render status updates via SSE and polling
 */

import { useEffect, useRef } from "react";
import { SSEClient } from "@/lib/sse-client";
import { retryFetch } from "@/lib/retry";
import type { RenderJob, RenderStatus } from "@/types";

interface UseRenderStatusOptions {
  jobs: RenderJob[];
  onStatusUpdate: (jobId: string, status: RenderStatus) => void;
  pollInterval?: number; // milliseconds
}

/**
 * Hook to manage render status updates via SSE (with polling fallback)
 */
export function useRenderStatus({ jobs, onStatusUpdate, pollInterval = 5000 }: UseRenderStatusOptions) {
  const jobsRef = useRef<RenderJob[]>([]);
  const pollIntervalRef = useRef<number | null>(null);
  const sseClientRef = useRef<SSEClient | null>(null);
  const pollRetryCountRef = useRef<Map<string, number>>(new Map());

  // Keep jobs ref in sync
  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  const renderingJobs = jobs.filter((j) => j.status === "rendering");
  const hasRenderingJobs = renderingJobs.length > 0;

  // SSE connection for real-time updates
  useEffect(() => {
    if (!hasRenderingJobs) {
      if (sseClientRef.current) {
        sseClientRef.current.disconnect();
        sseClientRef.current = null;
      }
      return;
    }

    // Initialize SSE client if not exists
    if (!sseClientRef.current) {
      sseClientRef.current = new SSEClient("/api/render-events");
    }

    const renderIds = renderingJobs.map((j) => j.id);
    sseClientRef.current.updateRenderIds(renderIds);

    // Subscribe to updates for each rendering job
    const unsubscribes: Array<() => void> = [];
    for (const job of renderingJobs) {
      const unsubscribe = sseClientRef.current.subscribe(job.id, (event) => {
        const status: RenderStatus = {
          status:
            event.data.status === "completed"
              ? "completed"
              : event.data.status === "error"
                ? "error"
                : "rendering",
          progress: event.data.progress,
          etaSeconds: event.data.etaSeconds,
          videoUrl: event.data.videoUrl,
          errorMessage: event.data.errorMessage,
        };

        onStatusUpdate(job.id, status);
      });
      unsubscribes.push(unsubscribe);
    }

    return () => {
      unsubscribes.forEach((unsub) => unsub());
    };
  }, [hasRenderingJobs, renderingJobs.map((j) => j.id).join(","), onStatusUpdate]);

  // Fallback polling when SSE is not available or fails
  useEffect(() => {
    const pollOnce = async () => {
      const targets = jobsRef.current.filter((j) => j.status === "rendering");
      if (targets.length === 0) return;

      await Promise.all(
        targets.map(async (job) => {
          try {
            const res = await retryFetch(
              `/api/render-status?sandboxId=${encodeURIComponent(job.id)}`,
              {
                cache: "no-store",
              },
              {
                maxAttempts: 2, // Fewer retries for polling
                initialDelayMs: 500,
              }
            );

            if (!res.ok) {
              // Increment retry count
              const retryCount = pollRetryCountRef.current.get(job.id) || 0;
              pollRetryCountRef.current.set(job.id, retryCount + 1);
              return;
            }

            // Reset retry count on success
            pollRetryCountRef.current.delete(job.id);

            const data = (await res.json()) as RenderStatus;
            onStatusUpdate(job.id, data);
          } catch (error) {
            // Increment retry count on error
            const retryCount = pollRetryCountRef.current.get(job.id) || 0;
            pollRetryCountRef.current.set(job.id, retryCount + 1);

            // Only log after multiple failures
            if (retryCount >= 3) {
              console.error(`Polling failed for job ${job.id}:`, error);
            }
          }
        })
      );
    };

    // Only use polling as fallback if SSE is not connected
    const usePolling = hasRenderingJobs && (!sseClientRef.current || !sseClientRef.current.isConnected());

    if (!usePolling) {
      if (pollIntervalRef.current !== null) {
        window.clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
      return;
    }

    // Poll immediately, then set interval
    void pollOnce();

    if (pollIntervalRef.current === null) {
      pollIntervalRef.current = window.setInterval(pollOnce, pollInterval);
    }

    return () => {
      if (pollIntervalRef.current !== null) {
        window.clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [hasRenderingJobs, pollInterval, onStatusUpdate]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (sseClientRef.current) {
        sseClientRef.current.disconnect();
        sseClientRef.current = null;
      }
      if (pollIntervalRef.current !== null) {
        window.clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, []);

  /**
   * Manually refresh status for all rendering jobs
   */
  const refreshStatus = async () => {
    const targets = jobsRef.current.filter((j) => j.status === "rendering");
    if (targets.length === 0) return;

    await Promise.all(
      targets.map(async (job) => {
        try {
          const res = await retryFetch(
            `/api/render-status?sandboxId=${encodeURIComponent(job.id)}`,
            {
              cache: "no-store",
            },
            {
              maxAttempts: 2,
              initialDelayMs: 500,
            }
          );
          if (!res.ok) return;
          const data = (await res.json()) as RenderStatus;
          onStatusUpdate(job.id, data);
        } catch {
          // ignore
        }
      })
    );
  };

  return { refreshStatus };
}
