/**
 * Sandbox types - E2B sandbox related types
 */

import type { Sandbox } from "e2b";

export interface SandboxCommandResult {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

export interface SandboxFile {
  name: string;
  path: string;
  size?: number;
  isDirectory?: boolean;
}

export interface SandboxProgress {
  status?: "rendering" | "completed" | "cancelled";
  frameStart?: number;
  frameEnd?: number;
  frameCount?: number;
  currentFrame?: number;
  framesDone?: number;
  startedAt?: number;
  updatedAt?: number;
}

export interface SandboxConnectionOptions {
  timeoutMs?: number;
}

export interface SandboxCreationOptions {
  timeoutMs?: number;
  template?: string;
}

export type SandboxInstance = Sandbox;
