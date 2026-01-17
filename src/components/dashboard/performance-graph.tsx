"use client"

import { useMemo, useEffect, useState } from "react"
import { CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer, Area, AreaChart } from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { aggregateJobsByTime, type TimeBucket } from "@/lib/metrics"
import type { RenderJob } from "@/types"

interface PerformanceGraphProps {
  jobs: RenderJob[]
}

export function PerformanceGraph({ jobs }: PerformanceGraphProps) {
  const [storedMetrics, setStoredMetrics] = useState<TimeBucket[]>([])

  // Load stored metrics from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem("tenet-performance-metrics")
      if (stored) {
        const parsed = JSON.parse(stored) as TimeBucket[]
        setStoredMetrics(parsed)
      }
    } catch {
      // Ignore parse errors
    }
  }, [])

  // Aggregate current jobs and merge with stored metrics
  const data = useMemo(() => {
    const currentMetrics = aggregateJobsByTime(jobs, 60, 12)

    // Merge with stored metrics, preferring current data
    const merged = new Map<string, TimeBucket>()

    // Add stored metrics first
    for (const bucket of storedMetrics) {
      merged.set(bucket.time, bucket)
    }

    // Override with current metrics
    for (const bucket of currentMetrics) {
      merged.set(bucket.time, bucket)
    }

    // Convert to array and sort by time
    const result = Array.from(merged.values()).sort((a, b) => {
      const [aHour, aMin] = a.time.split(":").map(Number)
      const [bHour, bMin] = b.time.split(":").map(Number)
      return aHour * 60 + aMin - (bHour * 60 + bMin)
    })

    // Store updated metrics
    if (result.length > 0) {
      try {
        localStorage.setItem("tenet-performance-metrics", JSON.stringify(result))
      } catch {
        // Ignore storage errors
      }
    }

    // If no data, return empty array with placeholder
    if (result.length === 0) {
      return [
        { time: "00:00", renderTime: 0, activeJobs: 0 },
        { time: "12:00", renderTime: 0, activeJobs: 0 },
      ]
    }

    return result
  }, [jobs, storedMetrics])

  // Calculate max values for Y-axis scaling
  const maxRenderTime = Math.max(...data.map((d) => d.renderTime), 1)
  const maxActiveJobs = Math.max(...data.map((d) => d.activeJobs), 1)
  return (
    <Card className="glass rounded-xl h-full relative">
      <div className="absolute top-0 left-0 w-1 h-full bg-accent/50 rounded-l-xl" />

      <CardHeader className="pb-0 pt-6">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-mono uppercase tracking-widest text-muted-foreground">
            02 / Cluster Performance
          </CardTitle>
          <div className="flex gap-4 text-xs font-mono">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-primary rounded-full" />
              <span>RENDER_TIME (s)</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-accent rounded-full" />
              <span>ACTIVE_JOBS</span>
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent className="h-[calc(100%-80px)] w-full pt-4">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="colorRender" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-primary)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="var(--color-primary)" stopOpacity={0} />
              </linearGradient>
              <linearGradient id="colorJobs" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-accent)" stopOpacity={0.3} />
                <stop offset="95%" stopColor="var(--color-accent)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
            <XAxis
              dataKey="time"
              stroke="var(--color-muted-foreground)"
              fontSize={10}
              tickLine={false}
              axisLine={false}
              fontFamily="var(--font-mono)"
            />
            <YAxis
              yAxisId="left"
              stroke="var(--color-primary)"
              fontSize={10}
              tickLine={false}
              axisLine={false}
              fontFamily="var(--font-mono)"
              domain={[0, maxRenderTime * 1.1]}
              label={{ value: "Render Time (s)", angle: -90, position: "insideLeft", style: { textAnchor: "middle" } }}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              stroke="var(--color-accent)"
              fontSize={10}
              tickLine={false}
              axisLine={false}
              fontFamily="var(--font-mono)"
              domain={[0, maxActiveJobs + 1]}
              label={{ value: "Active Jobs", angle: 90, position: "insideRight", style: { textAnchor: "middle" } }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "oklch(0.12 0 0 / 0.8)",
                backdropFilter: "blur(12px)",
                border: "1px solid oklch(0.5 0 0 / 0.1)",
                borderRadius: "8px",
                fontFamily: "var(--font-mono)",
                fontSize: "12px",
                textTransform: "uppercase",
              }}
              formatter={(value: number, name: string) => {
                if (name === "renderTime") return [`${value}s`, "Render Time"]
                if (name === "activeJobs") return [value, "Active Jobs"]
                return [value, name]
              }}
            />
            <Area
              yAxisId="left"
              type="monotone"
              dataKey="renderTime"
              stroke="var(--color-primary)"
              strokeWidth={2}
              fillOpacity={1}
              fill="url(#colorRender)"
            />
            <Area
              yAxisId="right"
              type="monotone"
              dataKey="activeJobs"
              stroke="var(--color-accent)"
              strokeWidth={2}
              fillOpacity={1}
              fill="url(#colorJobs)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}
