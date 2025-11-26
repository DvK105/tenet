"use client"

import { useEffect, useRef } from "react"
import { ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useRouter } from "next/navigation"

export function HeroSection() {
  const titleRef = useRef<HTMLHeadingElement>(null)
  const router = useRouter()

  useEffect(() => {
    const title = titleRef.current
    if (title) {
      title.style.opacity = "0"
      title.style.transform = "translateY(40px)"

      setTimeout(() => {
        title.style.transition = "all 1s cubic-bezier(0.16, 1, 0.3, 1)"
        title.style.opacity = "1"
        title.style.transform = "translateY(0)"
      }, 200)
    }
  }, [])

  const goToDashboard = () => router.push("/dashboard")

  return (
    <section className="relative min-h-screen flex flex-col items-center justify-center px-6 pt-20">
      {/* Animated accent line */}
      <div className="absolute top-1/4 left-0 w-px h-32 bg-gradient-to-b from-transparent via-primary to-transparent animate-pulse" />
      <div className="absolute top-1/3 right-0 w-px h-48 bg-gradient-to-b from-transparent via-primary to-transparent animate-pulse delay-500" />

      {/* Tagline */}
      <div className="flex items-center gap-3 mb-8 animate-fade-in">
        <div className="w-8 h-px bg-primary" />
        <span className="font-mono text-xs tracking-[0.3em] text-primary uppercase">TENET Render Systems</span>
        <div className="w-8 h-px bg-primary" />
      </div>

      {/* Main headline */}
      <h1
        ref={titleRef}
        className="text-5xl md:text-7xl lg:text-8xl font-light text-center text-foreground tracking-tight max-w-5xl leading-[0.95]"
      >
        <span className="block text-balance">Render Without</span>
        <span className="block text-primary text-balance">Limitation</span>
      </h1>

      {/* Subtitle */}
      <p className="mt-8 text-lg md:text-xl text-muted-foreground text-center max-w-2xl font-light leading-relaxed animate-fade-in animation-delay-300">
        Upload your files. Get them rendered on our distributed network. Download the results. Zero friction. Maximum
        power.
      </p>

      {/* CTA Buttons */}
      <div className="mt-12 flex flex-col sm:flex-row items-center gap-4 animate-fade-in animation-delay-500">
        <Button
          onClick={goToDashboard}
          className="group relative font-mono text-sm tracking-wide px-8 py-4 hover:shadow-[0_0_30px_rgba(0,200,200,0.3)]"
        >
          Start Rendering
          <div className="absolute inset-0 border border-primary opacity-0 group-hover:opacity-100 group-hover:scale-105 transition-all duration-500" />
        </Button>
        <Button variant="outline" className="font-mono text-sm tracking-wide px-8 py-4">
          View Documentation
        </Button>
      </div>

      {/* Scroll indicator */}
      <div className="absolute bottom-12 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 animate-bounce">
        <span className="font-mono text-xs tracking-widest text-muted-foreground uppercase">Scroll</span>
        <ChevronDown className="w-5 h-5 text-primary" />
      </div>

      {/* Corner accents */}
      <div className="absolute top-24 left-6 w-16 h-16 border-l border-t border-border opacity-50" />
      <div className="absolute bottom-24 right-6 w-16 h-16 border-r border-b border-border opacity-50" />
    </section>
  )
}
