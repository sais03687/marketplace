import { Hero } from "@/components/home/hero";
import { HowItWorks } from "@/components/home/how-it-works";
import { GapTable } from "@/components/home/gap-table";
import { FeaturedAgents } from "@/components/home/featured-agents";

export const dynamic = "force-dynamic";

export default function HomePage() {
  return (
    <>
      <Hero />
      <HowItWorks />
      <GapTable />
      <FeaturedAgents />
    </>
  );
}
