/**
 * Render job types - Core types for render job lifecycle
 */

export type RenderJobStatus = "uploading" | "rendering" | "completed" | "error" | "cancelled";

export interface RenderJob {
  id: string;
  fileName: string;
  createdAt: number;
  completedAt?: number;
  status: RenderJobStatus;
  progress?: number;
  etaSeconds?: number;
  videoUrl?: string;
  errorMessage?: string;
  fileSize?: number;
  frameCount?: number;
  framesDone?: number;
  sandboxId?: string;
  userId?: string; // For future Clerk integration
}

export interface RenderStatus {
  status: "rendering" | "completed" | "error" | "cancelled";
  progress?: number;
  etaSeconds?: number;
  videoUrl?: string;
  fileSize?: number;
  frameCount?: number;
  framesDone?: number;
  errorMessage?: string;
  storage?: "supabase" | "local";
  publicBucket?: boolean;
}

export interface FrameData {
  frameStart: number;
  frameEnd: number;
  frameCount?: number;
  fps?: number;
  error?: string;
  errorType?: string;
}
