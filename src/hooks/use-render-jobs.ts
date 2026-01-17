/**
 * Hook for managing render jobs state
 */

import { useState, useCallback } from "react";
import type { RenderJob } from "@/types";

export function useRenderJobs() {
  const [jobs, setJobs] = useState<RenderJob[]>([]);

  const addJob = useCallback((job: RenderJob) => {
    setJobs((prev) => [job, ...prev]);
  }, []);

  const updateJob = useCallback((jobId: string, updates: Partial<RenderJob>) => {
    setJobs((prev) =>
      prev.map((j) => (j.id === jobId ? { ...j, ...updates } : j))
    );
  }, []);

  const removeJob = useCallback((jobId: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
  }, []);

  const clearJobs = useCallback(() => {
    setJobs([]);
  }, []);

  return {
    jobs,
    setJobs,
    addJob,
    updateJob,
    removeJob,
    clearJobs,
  };
}
