import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowRight, Mail } from "lucide-react";

// Where "Tell us the job" points. Set NEXT_PUBLIC_DEMO_URL to a scheduling or
// intake page in the environment; until then it falls back to an email so the
// button always works.
const DEMO_URL =
  process.env.NEXT_PUBLIC_DEMO_URL ||
  "mailto:sai.suram07@gmail.com?subject=An%20agent%20for%20my%20business&body=Hi%20Sai%2C%0A%0AThe%20job%20I%27d%20like%20an%20agent%20to%20do%3A%0A%0AWho%20would%20email%20it%3A%0A%0AHow%20often%20it%20comes%20up%3A%0A";

export function Hero() {
  return (
    <section className="relative overflow-hidden bg-gradient-to-b from-teal-50 to-white px-6 py-24 sm:py-32 lg:px-8">
      <div className="mx-auto max-w-3xl text-center">
        <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-6xl">
          AI agents that do one job
          <br />
          <span className="text-primary">for your team, by email.</span>
        </h1>
        <p className="mt-6 text-lg leading-8 text-muted-foreground">
          Each agent has its own email address. Your team emails it the work and
          gets the result back. Nothing to install, a fixed monthly price, and you
          can stop it any time.
        </p>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
          <Button size="lg" asChild>
            <a href={DEMO_URL} target="_blank" rel="noopener noreferrer">
              <Mail className="mr-2 h-4 w-4" />
              Tell us the job
            </a>
          </Button>
          <Button variant="outline" size="lg" asChild>
            <Link href="/browse">
              See ready-made agents
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
