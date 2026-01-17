import { Coins } from "lucide-react"

export function CreditsWidget() {
  return (
    <div className="bg-card border border-border rounded-none px-4 py-2 flex items-center gap-3 min-w-[140px]">
      <Coins size={16} className="text-accent" />
      <div className="flex flex-col">
        <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">Credits</span>
        <span className="text-lg font-mono font-bold text-accent">4,250</span>
      </div>
    </div>
  )
}
