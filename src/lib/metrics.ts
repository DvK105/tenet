export type RenderJob = {
  id: string
  fileName: string
  createdAt: number
  completedAt?: number
  status: "uploading" | "rendering" | "completed" | "error"
  progress?: number
  etaSeconds?: number
  videoUrl?: string
  errorMessage?: string
  fileSize?: number
}

export type TimeBucket = {
  time: string
  renderTime: number // Average render time in seconds
  activeJobs: number // Number of active jobs at this time
}

/**
 * Calculate render time in seconds from job timestamps
 */
export function calculateRenderTime(job: RenderJob): number | null {
  if (job.status !== "completed" || !job.completedAt || !job.createdAt) {
    return null
  }
  return (job.completedAt - job.createdAt) / 1000 // Convert to seconds
}

/**
 * Aggregate jobs into time buckets for performance graph
 * @param jobs Array of render jobs
 * @param bucketSizeMinutes Size of each time bucket in minutes (default: 60)
 * @param maxBuckets Maximum number of buckets to return (default: 12)
 */
export function aggregateJobsByTime(
  jobs: RenderJob[],
  bucketSizeMinutes: number = 60,
  maxBuckets: number = 12
): TimeBucket[] {
  if (jobs.length === 0) {
    return []
  }

  const now = Date.now()
  const bucketSizeMs = bucketSizeMinutes * 60 * 1000
  const buckets: Map<number, { renderTimes: number[]; activeJobs: Set<string> }> = new Map()

  // Initialize buckets for the last maxBuckets time periods
  for (let i = maxBuckets - 1; i >= 0; i--) {
    const bucketStart = now - i * bucketSizeMs
    const bucketKey = Math.floor(bucketStart / bucketSizeMs) * bucketSizeMs
    buckets.set(bucketKey, { renderTimes: [], activeJobs: new Set() })
  }

  // Process each job
  for (const job of jobs) {
    const jobStartTime = job.createdAt
    const bucketKey = Math.floor(jobStartTime / bucketSizeMs) * bucketSizeMs

    // Only include buckets within our range
    if (buckets.has(bucketKey)) {
      const bucket = buckets.get(bucketKey)!

      // Track active jobs (rendering status at bucket time)
      if (job.status === "rendering" || job.status === "uploading") {
        bucket.activeJobs.add(job.id)
      }

      // Track completed render times
      if (job.status === "completed") {
        const renderTime = calculateRenderTime(job)
        if (renderTime !== null) {
          bucket.renderTimes.push(renderTime)
        }
      }
    }
  }

  // Convert to array and calculate averages
  const result: TimeBucket[] = []
  const sortedBuckets = Array.from(buckets.entries()).sort((a, b) => a[0] - b[0])

  for (const [bucketKey, bucket] of sortedBuckets) {
    const avgRenderTime =
      bucket.renderTimes.length > 0
        ? bucket.renderTimes.reduce((sum, t) => sum + t, 0) / bucket.renderTimes.length
        : 0

    const date = new Date(bucketKey)
    const timeLabel = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`

    result.push({
      time: timeLabel,
      renderTime: Math.round(avgRenderTime),
      activeJobs: bucket.activeJobs.size,
    })
  }

  return result
}

/**
 * Calculate system status metrics from jobs
 */
export function calculateSystemStatus(jobs: RenderJob[]) {
  const now = Date.now()
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)

  const activeRenders = jobs.filter((j) => j.status === "rendering").length
  const completedToday = jobs.filter(
    (j) => j.status === "completed" && j.completedAt && j.completedAt >= todayStart.getTime()
  ).length

  const completedJobs = jobs.filter((j) => j.status === "completed")
  const renderTimes = completedJobs.map(calculateRenderTime).filter((t): t is number => t !== null)

  const avgRenderTime = renderTimes.length > 0 ? renderTimes.reduce((sum, t) => sum + t, 0) / renderTimes.length : 0

  // Estimate storage usage from file sizes
  const totalStorageBytes = jobs
    .filter((j) => j.fileSize !== undefined)
    .reduce((sum, j) => sum + (j.fileSize || 0), 0)

  const totalStorageGB = totalStorageBytes / (1024 * 1024 * 1024)

  return {
    activeRenders,
    completedToday,
    avgRenderTimeSeconds: Math.round(avgRenderTime),
    totalStorageGB: Math.round(totalStorageGB * 100) / 100, // Round to 2 decimals
  }
}
