"use client"

import { Button } from "@/components/ui/button"

export function Footer() {
  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: "smooth" })
  }

  return (
    <footer className="relative border-t border-border">
      <div className="max-w-7xl mx-auto px-6 py-16">
        <div className="grid md:grid-cols-4 gap-12">
          {/* Brand */}
          <div className="md:col-span-2">
            <div className="flex items-center gap-2 mb-4">
              
              <span className="font-bbh text-lg tracking-widest text-foreground">TENET</span>
            </div>
            <p className="text-sm text-muted-foreground max-w-xs leading-relaxed">
              Industrial-grade cloud rendering infrastructure. Designed for artists who demand power.
            </p>
            <div className="mt-6 flex items-center gap-1">
              <div className="w-2 h-2 bg-primary rounded-full animate-pulse" />
              <span className="font-mono text-xs text-primary">All systems operational</span>
            </div>
          </div>

          {/* Links */}
          <div>
            <h4 className="font-mono text-xs tracking-widest text-muted-foreground uppercase mb-4">Product</h4>
            <ul className="space-y-3">
              {["Features", "Pricing", "Documentation", "API Reference", "Status"].map((link) => (
                <li key={link}>
                  <a href="#" className="text-sm text-foreground hover:text-primary transition-colors duration-300">
                    {link}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="font-mono text-xs tracking-widest text-muted-foreground uppercase mb-4">Company</h4>
            <ul className="space-y-3">
              {["About", "Blog", "Careers", "Contact", "Legal"].map((link) => (
                <li key={link}>
                  <a href="#" className="text-sm text-foreground hover:text-primary transition-colors duration-300">
                    {link}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="mt-16 pt-8 border-t border-border flex flex-col md:flex-row items-center justify-between gap-4">
          <p className="font-mono text-xs text-muted-foreground">© 2025 TENET Render Systems. All rights reserved.</p>
          <Button
            variant="ghost"
            onClick={scrollToTop}
            className="group flex items-center gap-2 font-mono text-xs text-muted-foreground hover:text-primary transition-colors duration-300"
          >
            Back to top
            <span className="group-hover:-translate-y-1 transition-transform duration-300">↑</span>
          </Button>
        </div>
      </div>
    </footer>
  )
}
