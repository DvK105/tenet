"use client"

import { useMemo } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { calculateSystemStatus, type RenderJob } from "@/lib/metrics"

interface SystemStatusProps {
  jobs: RenderJob[]
}

export function SystemStatus({ jobs }: SystemStatusProps) {
  const metrics = useMemo(() => calculateSystemStatus(jobs), [jobs])

  const formatRenderTime = (seconds: number): string => {
    if (seconds < 60) return `${seconds}s`
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.round((seconds % 3600) / 60)
    return `${hours}h ${minutes}m`
  }

  const formatStorage = (gb: number): string => {
    if (gb < 1) return `${Math.round(gb * 1024)}MB`
    if (gb < 1024) return `${gb.toFixed(2)}GB`
    return `${(gb / 1024).toFixed(2)}TB`
  }

  // Determine status based on metrics
  const getActiveRendersStatus = (): "normal" | "warning" | "high" => {
    if (metrics.activeRenders === 0) return "normal"
    if (metrics.activeRenders > 10) return "high"
    return "normal"
  }

  const getStorageStatus = (): "normal" | "warning" | "high" => {
    // Assuming a reasonable limit - adjust as needed
    const limitGB = 1000
    const usagePercent = (metrics.totalStorageGB / limitGB) * 100
    if (usagePercent > 80) return "warning"
    if (usagePercent > 95) return "high"
    return "normal"
  }

  return (
    <Card className="h-full glass rounded-xl flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-mono uppercase tracking-widest text-muted-foreground">
          System Status
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col justify-between gap-4">
        <StatusItem
          label="Active Renders"
          value={metrics.activeRenders.toString()}
          status={getActiveRendersStatus()}
        />
        <StatusItem
          label="Completed Today"
          value={metrics.completedToday.toString()}
          status="normal"
        />
        <StatusItem
          label="Avg Render Time"
          value={metrics.avgRenderTimeSeconds > 0 ? formatRenderTime(metrics.avgRenderTimeSeconds) : "N/A"}
          status="normal"
        />
        <StatusItem
          label="Storage Used"
          value={formatStorage(metrics.totalStorageGB)}
          sub={metrics.totalStorageGB > 0 ? `${Math.round((metrics.totalStorageGB / 1000) * 100)}% of 1TB` : undefined}
          status={getStorageStatus()}
        />

        <div className="mt-auto pt-4 border-t border-border">
          <div className="flex justify-between items-center">
            <span className="text-xs font-mono text-muted-foreground">TOTAL_JOBS</span>
            <span className="text-xl font-mono font-bold text-accent">
              {jobs.length}
              <span className="text-xs text-muted-foreground ml-1">
                ({metrics.activeRenders} active)
              </span>
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function StatusItem({
  label,
  value,
  sub,
  status,
}: { label: string; value: string; sub?: string; status: "normal" | "warning" | "high" }) {
  return (
    <div className="flex items-center justify-between glass-subtle rounded-lg px-3 py-2">
      <span className="text-xs font-mono text-muted-foreground uppercase">{label}</span>
      <div className="text-right">
        <div
          className={`font-mono font-bold ${
            status === "high" ? "text-primary" : status === "warning" ? "text-yellow-500" : "text-foreground"
          }`}
        >
          {value}
        </div>
        {sub && <div className="text-[10px] font-mono text-muted-foreground">{sub}</div>}
      </div>
    </div>
  )
}
