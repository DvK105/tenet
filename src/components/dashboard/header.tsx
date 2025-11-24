import { Bell, Search, Coins } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export function Header() {
  return (
    <header className="h-16 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 px-6 flex items-center justify-between z-10">
      <div className="flex items-center gap-4">
        <h1 className="text-sm font-medium tracking-widest uppercase text-muted-foreground">
          <span className="text-foreground font-bold mr-2">DASHBOARD</span> / OVERVIEW
        </h1>
      </div>

      <div className="flex items-center gap-6">
        <div className="hidden md:flex items-center relative group">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground w-4 h-4 group-focus-within:text-primary transition-colors" />
          <Input
            placeholder="SEARCH_PROJECTS"
            className="pl-9 w-64 bg-muted/30 border-transparent hover:border-border focus:border-primary rounded-none font-mono text-xs h-9 transition-all"
          />
          <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1">
            <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100">
              <span className="text-xs">⌘</span>K
            </kbd>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 bg-card border border-border px-3 py-1.5">
            <Coins size={14} className="text-accent" />
            <div className="flex flex-col">
              <span className="text-[9px] font-mono text-foreground uppercase tracking-wider leading-none">
                Credits
              </span>
              <span className="text-sm font-mono font-bold text-accent leading-none mt-0.5">4,250</span>
            </div>
          </div>

          <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
            <div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
            SYSTEM ONLINE
          </div>

          <Button variant="ghost" size="icon" className="rounded-none text-muted-foreground hover:text-primary">
            <Bell size={18} />
          </Button>

          <div className="w-8 h-8 bg-muted flex items-center justify-center border border-border text-xs font-mono font-medium">
            US
          </div>
        </div>
      </div>
    </header>
  )
}
