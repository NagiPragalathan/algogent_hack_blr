import { Hero } from "@/components/hero";
import { AgentsPreview } from "@/components/agents/agents-preview";
import { Mission } from "@/components/mission";
import { Solution } from "@/components/solution";
import { Pricing } from "@/components/pricing";
import { CTA } from "@/components/cta";

/** The landing page: the pitch, the catalogue in preview, and the price. */
export function Home() {
  return (
    <>
      <Hero />
      <AgentsPreview />
      <Mission />
      <Solution />
      <Pricing />
      <CTA />
    </>
  );
}
