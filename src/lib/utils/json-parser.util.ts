/**
 * JSON parsing utilities - Extract JSON from noisy output
 */

import { extractJson, cleanExitCodeMarkers } from "@/lib/errors/error-parser";

export { extractJson, cleanExitCodeMarkers };

/**
 * Parse JSON with fallback strategies
 */
export function parseJsonSafe<T = unknown>(output: string, expectedKeys?: string[]): T | null {
  const result = extractJson<T>(output, expectedKeys);
  return result.data ?? null;
}
