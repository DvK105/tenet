/**
 * Error parsing utilities - Extract JSON and handle Blender output
 */

import type { BlendFrameData, BlenderRenderResult } from "@/types/blender.types";

export interface ParseResult<T> {
  data: T | null;
  error?: string;
  wasTruncated?: boolean;
}

/**
 * Remove EXIT_CODE markers from output
 */
export function cleanExitCodeMarkers(output: string): string {
  return output.replace(/EXIT_CODE:\d+/g, "").trim();
}

/**
 * Extract JSON object from noisy output
 */
export function extractJson<T = unknown>(output: string, expectedKeys?: string[]): ParseResult<T> {
  const cleaned = cleanExitCodeMarkers(output);

  // Try line-by-line first (faster for well-formatted output)
  const lines = cleaned.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!expectedKeys || expectedKeys.some((key) => key in (parsed as Record<string, unknown>))) {
          return { data: parsed as T };
        }
      } catch {
        // Not valid JSON, continue
      }
    }
  }

  // Try to find JSON by balanced braces
  let braceCount = 0;
  let startIdx = -1;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === "{") {
      if (braceCount === 0) startIdx = i;
      braceCount++;
    } else if (cleaned[i] === "}") {
      braceCount--;
      if (braceCount === 0 && startIdx !== -1) {
        const candidate = cleaned.substring(startIdx, i + 1);
        try {
          const parsed = JSON.parse(candidate) as unknown;
          if (!expectedKeys || expectedKeys.some((key) => key in (parsed as Record<string, unknown>))) {
            return { data: parsed as T };
          }
        } catch {
          // Not valid JSON, continue searching
        }
        startIdx = -1;
      }
    }
  }

  return { data: null, error: "No valid JSON found in output" };
}

/**
 * Parse Blender frame data from output
 */
export function parseFrameData(output: string): ParseResult<BlendFrameData> {
  const result = extractJson<BlendFrameData>(output, ["frame_start", "error"]);
  return result;
}

/**
 * Parse Blender render result from output
 */
export function parseRenderResult(output: string): ParseResult<BlenderRenderResult> {
  const result = extractJson<BlenderRenderResult>(output, ["success", "error"]);
  return result;
}

/**
 * Check if output indicates segmentation fault
 */
export function hasSegmentationFault(output: string): boolean {
  const lower = output.toLowerCase();
  return (
    lower.includes("segmentation fault") ||
    lower.includes("segfault") ||
    lower.includes("sigsegv") ||
    /\d+\s+segmentation fault/i.test(output)
  );
}

/**
 * Check if output indicates timeout
 */
export function hasTimeout(output: string, exitCode?: number): boolean {
  if (exitCode === 124 || exitCode === 143) return true; // 124 = timeout, 143 = SIGTERM

  const lower = output.toLowerCase();
  return (
    lower.includes("terminated") ||
    lower.includes("[unknown] terminated") ||
    /\d+:\s*\[unknown\]\s*terminated/i.test(output) ||
    /timeout:\s*command\s+terminated/i.test(output)
  );
}

/**
 * Extract exit code from output (handles EXIT_CODE marker)
 */
export function extractExitCode(output: string, defaultExitCode?: number): number | undefined {
  const match = output.match(/EXIT_CODE:(\d+)/);
  if (match) {
    return Number.parseInt(match[1], 10);
  }
  return defaultExitCode;
}
