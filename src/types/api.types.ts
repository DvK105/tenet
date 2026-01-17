/**
 * API request and response types
 */

import type { FrameData, RenderStatus } from "./render-job.types";

export interface UploadBlenderRequest {
  file: File;
  extractFrames?: boolean;
  parallelChunks?: number;
}

export interface UploadBlenderResponse {
  success: boolean;
  sandboxId: string;
  frameData?: FrameData;
  warning?: string;
  error?: string;
}

export interface RenderStatusRequest {
  renderId?: string;
  sandboxId?: string;
}

export type RenderStatusResponse = RenderStatus;

export interface TriggerRenderRequest {
  renderId: string;
  inputObjectPath?: string;
  parallelChunks?: number;
  frameData?: FrameData;
}

export interface TriggerRenderResponse {
  success: boolean;
  renderId: string;
  error?: string;
}

export interface RenderEventsQueryParams {
  renderId: string | string[];
}
