export type JobStatus = "queued" | "rendering" | "paused" | "finished" | "error" | "canceled"

export interface Job {
  id: string
  name: string
  status: JobStatus
  progress: number
  frames: string
  time: string
}
