"use client"

import { Check } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { useRouter } from "next/navigation"

const plans = [
  {
    name: "Starter",
    price: "0",
    unit: "",
    description: "Perfect for small projects and individual artists.",
    features: ["Up to 5GB file uploads", "Standard render queue", "Email support", "7-day file retention"],
    highlighted: false,
  },
  {
    name: "Pro",
    price: "25",
    unit: "per 100 / credits",
    description: "For studios and teams with demanding workloads.",
    features: [
      "Unlimited file uploads",
      "Priority render queue",
      "24/7 chat support",
      "30-day file retention",
      "Team collaboration",
      "API access",
    ],
    highlighted: true,
  },
  {
    name: "Enterprise",
    price: "Custom",
    unit: "volume pricing",
    description: "Dedicated infrastructure for large-scale operations.",
    features: [
      "Everything in Pro",
      "Dedicated GPU clusters",
      "Dedicated account manager",
    ],
    highlighted: false,
  },
]

export function PricingSection() {
  const router = useRouter()
  const goToDashboard = () => router.push("/dashboard")
  return (
    <section id="pricing" className="relative py-32 px-6">
      <div className="max-w-6xl mx-auto">
        {/* Section header */}
        <div className="text-center mb-20">
          <span className="font-mono text-xs tracking-[0.3em] text-primary uppercase">Pricing</span>
          <h2 className="mt-4 text-4xl md:text-5xl font-light text-foreground tracking-tight">
            Simple, Transparent Rates
          </h2>
          <p className="mt-4 text-muted-foreground max-w-lg mx-auto">
            Pay only for the compute you use. No subscriptions. No hidden fees.
          </p>
        </div>

        {/* Pricing cards */}
        <div className="grid md:grid-cols-3 gap-8">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className={cn(
                "relative group p-8 border transition-all duration-500",
                plan.highlighted
                  ? "border-primary bg-card shadow-[0_0_40px_rgba(0,200,200,0.1)]"
                  : "border-border hover:border-primary/50",
              )}
            >
              {/* Highlighted badge */}
              {plan.highlighted && (
                <div className="absolute -top-px left-1/2 -translate-x-1/2 px-4 py-1 bg-primary">
                  <span className="font-mono text-xs text-primary-foreground tracking-widest uppercase">Popular</span>
                </div>
              )}

              {/* Plan name */}
              <h3 className="font-mono text-sm tracking-widest text-muted-foreground uppercase">{plan.name}</h3>

              {/* Price */}
              <div className="mt-6">
                <span className="text-4xl font-light text-foreground">
                  {plan.price === "Custom" ? "" : "$"}
                  {plan.price}
                </span>
                <span className="ml-2 text-sm text-muted-foreground">{plan.unit}</span>
              </div>

              {/* Description */}
              <p className="mt-4 text-sm text-muted-foreground">{plan.description}</p>

              {/* Features */}
              <ul className="mt-8 space-y-4">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-3">
                    <div className="w-5 h-5 border border-primary/50 flex items-center justify-center shrink-0 mt-0.5">
                      <Check className="w-3 h-3 text-primary" />
                    </div>
                    <span className="text-sm text-foreground">{feature}</span>
                  </li>
                ))}
              </ul>

              {/* CTA */}
              <Button
                onClick={goToDashboard}
                className={cn(
                  "mt-10 w-full font-mono text-sm tracking-wide py-3 transition-all duration-500",
                  plan.highlighted
                    ? "hover:shadow-[0_0_30px_rgba(0,200,200,0.3)]"
                    : "",
                )}
                variant={plan.highlighted ? "default" : "outline"}
              >
                {plan.price === "Custom" ? "Contact Sales" : "Get Started"}
              </Button>

              {/* Corner accent */}
              <div className="absolute top-0 right-0 w-8 h-8 border-r border-t border-primary/20 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
