"use client"

import { CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer, Area, AreaChart } from "recharts"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

const data = [
  { time: "00:00", renderTime: 12, activeNodes: 4 },
  { time: "01:00", renderTime: 15, activeNodes: 6 },
  { time: "02:00", renderTime: 11, activeNodes: 5 },
  { time: "03:00", renderTime: 18, activeNodes: 8 },
  { time: "04:00", renderTime: 24, activeNodes: 12 },
  { time: "05:00", renderTime: 32, activeNodes: 15 },
  { time: "06:00", renderTime: 28, activeNodes: 14 },
  { time: "07:00", renderTime: 22, activeNodes: 10 },
  { time: "08:00", renderTime: 35, activeNodes: 18 },
  { time: "09:00", renderTime: 45, activeNodes: 24 },
  { time: "10:00", renderTime: 42, activeNodes: 22 },
  { time: "11:00", renderTime: 38, activeNodes: 20 },
]

export function PerformanceGraph() {
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
              <span>RENDER_TIME (ms)</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-accent rounded-full" />
              <span>ACTIVE_NODES</span>
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
              <linearGradient id="colorNodes" x1="0" y1="0" x2="0" y2="1">
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
              stroke="var(--color-muted-foreground)"
              fontSize={10}
              tickLine={false}
              axisLine={false}
              fontFamily="var(--font-mono)"
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
            />
            <Area
              type="monotone"
              dataKey="renderTime"
              stroke="var(--color-primary)"
              strokeWidth={2}
              fillOpacity={1}
              fill="url(#colorRender)"
            />
            <Area
              type="step"
              dataKey="activeNodes"
              stroke="var(--color-accent)"
              strokeWidth={2}
              fillOpacity={1}
              fill="url(#colorNodes)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}
