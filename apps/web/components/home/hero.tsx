import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";

export function Hero() {
  return (
    <section className="relative overflow-hidden bg-gradient-to-b from-teal-50 to-white px-6 py-24 sm:py-32 lg:px-8">
      <div className="mx-auto max-w-3xl text-center">
        <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-6xl">
          Your next hire is
          <br />
          <span className="text-primary">already trained.</span>
        </h1>
        <p className="mt-6 text-lg leading-8 text-muted-foreground">
          Browse, hire, and manage AI employees that work in your existing tools.
          No new interfaces to learn — they live in your email and Slack.
        </p>
        <div className="mt-10 flex items-center justify-center gap-4">
          <Button size="lg" asChild>
            <Link href="/browse">
              Browse Agents
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
          <Button variant="outline" size="lg" asChild>
            <Link href="/creator">Publish Your Agent</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
