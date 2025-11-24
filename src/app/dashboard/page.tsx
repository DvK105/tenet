import { RenderDashboard } from "@/components/dashboard/render-dashboard"

export default function Page() {
  return (
    <main className="min-h-screen bg-background text-foreground font-sans selection:bg-primary selection:text-primary-foreground overflow-hidden">
      <RenderDashboard />
    </main>
  )
}
