import { Hero } from "@/components/home/hero";
import { HowItWorks } from "@/components/home/how-it-works";
import { FeaturedAgents } from "@/components/home/featured-agents";

export const dynamic = "force-dynamic";

export default function HomePage() {
  return (
    <>
      <Hero />
      <HowItWorks />
      <FeaturedAgents />
    </>
  );
}
