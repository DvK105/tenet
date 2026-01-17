"use client"

import type React from "react"
import { Box, LayoutGrid, Settings, Activity, User } from "lucide-react"
import { Button } from "@/components/ui/button"

export function Sidebar({
  currentPage,
  onPageChange,
}: {
  currentPage: string
  onPageChange: (page: "upload" | "graph" | "status" | "account") => void
}) {
  return (
    <div className="w-16 md:w-20 h-full border-r glass-strong flex flex-col items-center py-6 gap-8 z-20">
      <div className="flex flex-col items-center gap-1">
        <div className="w-8 h-8 bg-primary flex items-center justify-center text-primary-foreground font-bold font-mono text-lg rounded-md">
          LV
        </div>
      </div>

      <nav className="flex-1 flex flex-col gap-6 w-full px-2">
        <SidebarButton
          icon={<Box size={20} />}
          active={currentPage === "upload"}
          label="Upload"
          onClick={() => onPageChange("upload")}
        />
        <SidebarButton
          icon={<LayoutGrid size={20} />}
          active={currentPage === "graph"}
          label="Graph"
          onClick={() => onPageChange("graph")}
        />
        <SidebarButton
          icon={<Activity size={20} />}
          active={currentPage === "status"}
          label="Status"
          onClick={() => onPageChange("status")}
        />
        <SidebarButton
          icon={<User size={20} />}
          active={currentPage === "account"}
          label="Account"
          onClick={() => onPageChange("account")}
        />
      </nav>

      <div className="flex flex-col gap-6 w-full px-2">
        <SidebarButton icon={<Settings size={20} />} label="Settings" />
      </div>
    </div>
  )
}

function SidebarButton({
  icon,
  active,
  label,
  onClick,
}: {
  icon: React.ReactNode
  active?: boolean
  label: string
  onClick?: () => void
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      className={`w-full aspect-square rounded-md hover:bg-muted hover:text-primary transition-colors relative group ${active ? "text-primary bg-muted/50" : "text-muted-foreground"}`}
      title={label}
    >
      {icon}
      {active && <div className="absolute right-0 top-1/2 -translate-y-1/2 w-0.5 h-6 bg-primary rounded-full" />}
      <span className="sr-only">{label}</span>
    </Button>
  )
}
