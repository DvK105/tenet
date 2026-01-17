import { Play, RefreshCw, Trash2, AlertTriangle, CheckCircle2, Clock, X } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

interface RenderQueueProps {
  jobs: Array<{
    id: string
    fileName: string
    createdAt: number
    status: "uploading" | "rendering" | "completed" | "error"
    progress?: number
    etaSeconds?: number
    videoUrl?: string
  }>
  onRefresh?: () => void | Promise<void>
  onClear?: () => void
}

export function RenderQueue({ jobs, onRefresh, onClear }: RenderQueueProps) {
  const sortedJobs = [...jobs].sort((a, b) => b.createdAt - a.createdAt)

  return (
    <Card className="glass rounded-xl">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-mono uppercase tracking-widest text-muted-foreground">
          03 / Render Queue
        </CardTitle>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="rounded-lg h-7 font-mono text-xs bg-transparent"
            onClick={() => onRefresh?.()}
            disabled={!onRefresh}
          >
            <RefreshCw className="w-3 h-3 mr-2" /> REFRESH
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="rounded-lg h-7 font-mono text-xs border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground bg-transparent"
            onClick={() => onClear?.()}
            disabled={!onClear}
          >
            <Trash2 className="w-3 h-3 mr-2" /> CLEAR
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent border-border">
              <TableHead className="w-[100px] font-mono text-xs uppercase">Job ID</TableHead>
              <TableHead className="font-mono text-xs uppercase">Project Name</TableHead>
              <TableHead className="w-[200px] font-mono text-xs uppercase">Status</TableHead>
              <TableHead className="w-[100px] font-mono text-xs uppercase text-right">Progress</TableHead>
              <TableHead className="w-[200px] font-mono text-xs uppercase text-right">ETA</TableHead>
              <TableHead className="w-[100px] font-mono text-xs uppercase text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedJobs.map((job) => (
              <TableRow key={job.id} className="border-border hover:bg-muted/20 group font-mono text-xs">
                <TableCell className="font-medium text-muted-foreground">{shortJobId(job.id)}</TableCell>
                <TableCell className="font-medium text-foreground">{job.fileName}</TableCell>
                <TableCell>
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between text-[10px]">
                      <span
                        className={`uppercase flex items-center gap-1.5 font-bold
                        ${
                          job.status === "rendering"
                            ? "text-primary"
                            : job.status === "completed"
                              ? "text-accent"
                              : job.status === "error"
                                ? "text-destructive"
                                : "text-muted-foreground"
                        }`}
                      >
                        {getStatusIcon(job.status)}
                        {job.status}
                      </span>
                      <span>{typeof job.progress === "number" ? `${Math.round(job.progress)}%` : "-"}</span>
                    </div>
                    <Progress value={job.progress ?? 0} className="h-1 rounded-full bg-muted" />
                  </div>
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {typeof job.progress === "number" ? `${Math.round(job.progress)}%` : "-"}
                </TableCell>
                <TableCell className="text-right text-muted-foreground">
                  {formatEtaCell(job.etaSeconds)}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 rounded-md hover:bg-primary hover:text-primary-foreground"
                      onClick={() => {
                        if (!job.videoUrl) return
                        window.open(job.videoUrl, "_blank", "noopener,noreferrer")
                      }}
                      disabled={!job.videoUrl}
                    >
                      <Play className="w-3 h-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 rounded-md hover:bg-destructive hover:text-destructive-foreground"
                      disabled
                    >
                      <X className="w-3 h-3" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function getStatusIcon(status: string) {
  switch (status) {
    case "rendering":
      return <RefreshCw className="w-3 h-3 animate-spin" />
    case "completed":
      return <CheckCircle2 className="w-3 h-3" />
    case "error":
      return <AlertTriangle className="w-3 h-3" />
    default:
      return <Clock className="w-3 h-3" />
  }
}

function shortJobId(id: string) {
  if (id.startsWith("LOCAL-")) return "LOCAL"
  if (id.length <= 8) return id
  return `${id.slice(0, 4)}…${id.slice(-4)}`
}

function pad2(n: number) {
  return String(n).padStart(2, "0")
}

function formatDuration(seconds: number) {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`
}

function formatClockTime(date: Date) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date)
}

function formatEtaCell(etaSeconds?: number) {
  if (typeof etaSeconds !== "number" || !Number.isFinite(etaSeconds) || etaSeconds < 0) return "--:--:--"
  const duration = formatDuration(etaSeconds)
  const etaAt = formatClockTime(new Date(Date.now() + etaSeconds * 1000))
  return `${duration} (${etaAt})`
}
