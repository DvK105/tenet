import { Play, RefreshCw, Trash2, AlertTriangle, CheckCircle2, Clock, X } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { Job } from "@/types/job"

interface RenderQueueProps {
  files: File[]
  jobs: Job[]
  onPause: (id: string) => void
  onCancel: (id: string) => void
  onClear: () => void
}

export function RenderQueue({ files, jobs, onPause, onCancel, onClear }: RenderQueueProps) {
  // In a real app, files would be converted to jobs here

  return (
    <Card className="border-border bg-card rounded-none">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-mono uppercase tracking-widest text-muted-foreground">
          03 / Render Queue
        </CardTitle>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="rounded-none h-7 font-mono text-xs bg-transparent">
            <RefreshCw className="w-3 h-3 mr-2" /> REFRESH
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="rounded-none h-7 font-mono text-xs border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground bg-transparent"
            onClick={onClear}
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
              <TableHead className="w-[100px] font-mono text-xs uppercase text-right">Frames</TableHead>
              <TableHead className="w-[120px] font-mono text-xs uppercase text-right">Duration</TableHead>
              <TableHead className="w-[100px] font-mono text-xs uppercase text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((job) => (
              <TableRow key={job.id} className="border-border hover:bg-muted/20 group font-mono text-xs">
                <TableCell className="font-medium text-muted-foreground">{job.id}</TableCell>
                <TableCell className="font-medium text-foreground">{job.name}</TableCell>
                <TableCell>
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between text-[10px]">
                      <span
                        className={`uppercase flex items-center gap-1.5 font-bold
                        ${
                          job.status === "rendering"
                            ? "text-primary"
                            : job.status === "finished"
                              ? "text-accent"
                              : job.status === "error"
                                ? "text-destructive"
                                : "text-muted-foreground"
                        }`}
                      >
                        {getStatusIcon(job.status)}
                        {job.status}
                      </span>
                      <span>{job.progress}%</span>
                    </div>
                    <Progress
                      value={job.progress}
                      className="h-1 rounded-none bg-muted"
                      // Custom indicator color based on status would be done via class names usually, but shadcn progress is simple.
                      // We'll rely on default primary color which is Orange, fitting for active.
                      // For accent/blue we'd need a custom component or class override.
                    />
                  </div>
                </TableCell>
                <TableCell className="text-right text-muted-foreground">{job.frames}</TableCell>
                <TableCell className="text-right text-muted-foreground">{job.time}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 rounded-none hover:bg-primary hover:text-primary-foreground"
                      onClick={() => onPause(job.id)}
                    >
                      <Play className="w-3 h-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 rounded-none hover:bg-destructive hover:text-destructive-foreground"
                      onClick={() => onCancel(job.id)}
                    >
                      <X className="w-3 h-3" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {files.map((file, i) => (
              <TableRow key={i} className="border-border hover:bg-muted/20 group font-mono text-xs">
                <TableCell className="font-medium text-muted-foreground">PENDING...</TableCell>
                <TableCell className="font-medium text-foreground">{file.name}</TableCell>
                <TableCell>
                  <span className="text-muted-foreground uppercase flex items-center gap-1.5">
                    <Clock className="w-3 h-3" /> UPLOADING...
                  </span>
                </TableCell>
                <TableCell className="text-right text-muted-foreground">-</TableCell>
                <TableCell className="text-right text-muted-foreground">-</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="icon" className="h-6 w-6 rounded-none">
                    <X className="w-3 h-3" />
                  </Button>
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
    case "finished":
      return <CheckCircle2 className="w-3 h-3" />
    case "error":
      return <AlertTriangle className="w-3 h-3" />
    default:
      return <Clock className="w-3 h-3" />
  }
}
