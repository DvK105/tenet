"use client"

import { useState, useEffect } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

export function Header() {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 50)
    }
    window.addEventListener("scroll", handleScroll)
    return () => window.removeEventListener("scroll", handleScroll)
  }, [])

  const scrollToSection = (id: string) => {
    const element = document.getElementById(id)
    if (element) {
      element.scrollIntoView({ behavior: "smooth" })
    }
  }

  return (
    <header
      className={cn(
        "fixed top-0 left-0 right-0 z-50 transition-all duration-500",
        scrolled ? "bg-background/80 backdrop-blur-xl border-b border-border" : "bg-transparent",
      )}
    >
      <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
        {/* Logo */}
        <div className="flex items-center gap-2">
          
          <span className="font-bbh text-lg tracking-widest text-foreground">TENET</span>
        </div>

        {/* Navigation */}
        <nav className="hidden md:flex items-center gap-8">
          {["Upload", "Pricing"].map((item) => (
            <Button
              key={item}
              onClick={() => scrollToSection(item.toLowerCase())}
              variant="ghost"
              className="font-mono text-sm text-muted-foreground hover:text-primary transition-colors duration-300 tracking-wide"
            >
              {item}
            </Button>
          ))}
        </nav>

        {/* CTA */}
        <Button
          onClick={() => scrollToSection("upload")}
          variant="outline"
          className="group relative font-mono text-sm tracking-wide px-6 py-2 border border-primary text-primary hover:bg-primary hover:text-primary-foreground transition-all duration-300"
        >
          <span className="relative z-10">Start Rendering</span>
          <div className="absolute inset-0 bg-primary/10 group-hover:bg-primary transition-all duration-300" />
        </Button>
      </div>
    </header>
  )
}
