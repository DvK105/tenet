/**
 * Progress calculation utilities - ETA and progress percentage
 */

import type { BlenderRenderProgress, SandboxProgress } from "@/types";

/**
 * Calculate progress percentage from frame data
 */
export function calculateProgress(
  framesDone: number,
  frameCount: number,
  min = 0,
  max = 100
): number {
  if (frameCount === 0) return 0;
  const progress = (framesDone / frameCount) * 100;
  return Math.max(min, Math.min(max, Math.round(progress * 100) / 100));
}

/**
 * Calculate ETA in seconds from progress data
 */
export function calculateETA(progress: SandboxProgress | BlenderRenderProgress): number {
  const { frameCount = 1, framesDone = 0, startedAt, updatedAt } = progress;

  if (framesDone === 0 || !startedAt || !updatedAt) {
    return 0;
  }

  const elapsedSeconds = (updatedAt - startedAt) / 1000;
  const framesPerSecond = framesDone / elapsedSeconds;

  if (framesPerSecond <= 0) {
    return 0;
  }

  const remainingFrames = frameCount - framesDone;
  return Math.round(remainingFrames / framesPerSecond);
}

/**
 * Calculate render time from job timestamps
 */
export function calculateRenderTime(createdAt: number, completedAt?: number): number | null {
  if (!completedAt || !createdAt) {
    return null;
  }
  return (completedAt - createdAt) / 1000; // Convert to seconds
}

/**
 * Format ETA to human-readable string
 */
export function formatETA(etaSeconds: number): string {
  if (etaSeconds < 60) {
    return `${etaSeconds}s`;
  }
  if (etaSeconds < 3600) {
    const minutes = Math.floor(etaSeconds / 60);
    const seconds = etaSeconds % 60;
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(etaSeconds / 3600);
  const minutes = Math.floor((etaSeconds % 3600) / 60);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}
