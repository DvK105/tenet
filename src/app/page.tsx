import { Header } from "@/components/landing/header"
import { HeroSection } from "@/components/landing/hero-section"
import { StatsSection } from "@/components/landing/stats-section"
import { UploadSection } from "@/components/landing/upload-section"
import { PricingSection } from "@/components/landing/pricing-section"
import { Footer } from "@/components/landing/footer"

export default function Home() {
  return (
    <main className="relative min-h-screen bg-background overflow-x-hidden">
      {/* Grid pattern overlay */}
      <div className="fixed inset-0 grid-pattern opacity-30 pointer-events-none" />

      {/* Scanline effect */}
      <div className="fixed inset-0 scanlines pointer-events-none" />

      {/* Content */}
      <div className="relative z-10">
        <Header />
        <HeroSection />
        <StatsSection />
        <UploadSection />
        <PricingSection />
        <Footer />
      </div>
    </main>
  )
}
