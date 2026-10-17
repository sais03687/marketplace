import { MessageSquare, AtSign, ShieldCheck } from "lucide-react";

const steps = [
  {
    icon: MessageSquare,
    title: "Tell us the job",
    description:
      "Describe the work you want off your plate, or pick a ready-made agent. We set it up and test it on real examples first.",
  },
  {
    icon: AtSign,
    title: "Email it the work",
    description:
      "The agent gets its own email address. Anyone you allow can email it a request and gets the result back.",
  },
  {
    icon: ShieldCheck,
    title: "Stay in control",
    description:
      "Choose whether it asks you before sending anything. A fixed monthly price, your data stays private, and you can stop it any time.",
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
