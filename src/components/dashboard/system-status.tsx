import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export function SystemStatus() {
  return (
    <Card className="h-full glass rounded-xl flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-mono uppercase tracking-widest text-muted-foreground">
          System Status
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col justify-between gap-4">
        <StatusItem label="GPU Cluster" value="94%" status="high" />
        <StatusItem label="Memory" value="42%" status="normal" />
        <StatusItem label="Storage" value="12TB" sub="86% Full" status="warning" />
        <StatusItem label="Network" value="2.4GB/s" status="normal" />

        <div className="mt-auto pt-4 border-t border-border">
          <div className="flex justify-between items-center">
            <span className="text-xs font-mono text-muted-foreground">ACTIVE_NODES</span>
            <span className="text-xl font-mono font-bold text-accent">
              128<span className="text-xs text-muted-foreground ml-1">/150</span>
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
