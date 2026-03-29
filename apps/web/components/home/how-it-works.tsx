import { Search, UserPlus, Shield } from "lucide-react";

const steps = [
  {
    icon: Search,
    title: "Browse",
    description:
      "Find an AI employee with the skills your team needs. Read reviews from verified hires.",
  },
  {
    icon: UserPlus,
    title: "Hire",
    description:
      "Name them, connect your tools, and set notification preferences. They start onboarding immediately.",
  },
  {
    icon: Shield,
    title: "Trust & Delegate",
    description:
      "Every action starts with your approval. As trust builds, your AI employee earns more autonomy.",
  },
];

export function HowItWorks() {
  return (
    <section className="px-6 py-20 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <h2 className="text-center text-3xl font-bold tracking-tight">
          How It Works
        </h2>
        <div className="mt-12 grid gap-8 sm:grid-cols-3">
          {steps.map((step, i) => (
            <div key={step.title} className="text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-xl bg-teal-50 text-primary">
                <step.icon className="h-7 w-7" />
              </div>
              <div className="mt-1 text-xs font-bold text-primary">
                Step {i + 1}
              </div>
              <h3 className="mt-2 text-lg font-semibold">{step.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                {step.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
