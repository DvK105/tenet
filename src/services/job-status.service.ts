/**
 * Job status service - Centralized job status management
 */

import { getRenderService } from "./render.service";
import { RenderJobError } from "@/lib/errors/render-errors";
import type { RenderStatus } from "@/types";

/**
 * Job status service for managing render job status
 */
export class JobStatusService {
  /**
   * Check status for a single render job
   */
  async checkStatus(renderId: string): Promise<RenderStatus> {
    try {
      const renderService = getRenderService();
      return await renderService.getStatus(renderId);
    } catch (error) {
      throw RenderJobError.fromStatus(renderId, error);
    }
  }

  /**
   * Check status for multiple render jobs
   */
  async checkStatusBatch(renderIds: string[]): Promise<Map<string, RenderStatus>> {
    const results = new Map<string, RenderStatus>();

    await Promise.all(
      renderIds.map(async (renderId) => {
        try {
          const status = await this.checkStatus(renderId);
          results.set(renderId, status);
        } catch (error) {
          // Set error status for failed checks
          results.set(renderId, {
            status: "error",
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      })
    );

    return results;
  }
}

// Singleton instance
let jobStatusServiceInstance: JobStatusService | null = null;

/**
 * Get job status service instance
 */
export function getJobStatusService(): JobStatusService {
  if (!jobStatusServiceInstance) {
    jobStatusServiceInstance = new JobStatusService();
  }
  return jobStatusServiceInstance;
}
