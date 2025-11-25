"use client"

import { useEffect, useRef, useState } from "react"

const stats = [
  { value: 10000, suffix: "+", label: "GPU Nodes", prefix: "" },
  { value: 99.9, suffix: "%", label: "Uptime", prefix: "" },
  { value: 50, suffix: "x", label: "Faster Renders", prefix: "" },
  { value: 24, suffix: "/7", label: "Support", prefix: "" },
]

function AnimatedNumber({ value, suffix, prefix }: { value: number; suffix: string; prefix: string }) {
  const [current, setCurrent] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const hasAnimated = useRef(false)

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !hasAnimated.current) {
          hasAnimated.current = true
          const duration = 2000
          const steps = 60
          const increment = value / steps
          let step = 0

          const timer = setInterval(() => {
            step++
            setCurrent(Math.min(increment * step, value))
            if (step >= steps) clearInterval(timer)
          }, duration / steps)
        }
      },
      { threshold: 0.5 },
    )

    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [value])

  return (
    <div ref={ref} className="font-mono text-4xl md:text-5xl text-primary font-light tracking-tight">
      {prefix}
      {Number.isInteger(value) ? Math.floor(current) : current.toFixed(1)}
      {suffix}
    </div>
  )
}

export function StatsSection() {
  return (
    <section className="relative py-24 px-6 border-y border-border">
      <div className="max-w-7xl mx-auto">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 md:gap-4">
          {stats.map((stat, index) => (
            <div
              key={stat.label}
              className="relative flex flex-col items-center text-center p-6 group"
              style={{ animationDelay: `${index * 100}ms` }}
            >
              {/* Vertical divider */}
              {index !== 0 && (
                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-px h-16 bg-border hidden md:block" />
              )}

              <AnimatedNumber value={stat.value} suffix={stat.suffix} prefix={stat.prefix} />
              <span className="mt-3 font-mono text-xs tracking-widest text-muted-foreground uppercase">
                {stat.label}
              </span>

              {/* Hover accent */}
              <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-0 h-px bg-primary group-hover:w-12 transition-all duration-500" />
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
