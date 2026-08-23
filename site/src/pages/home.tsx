import { Hero } from "@/components/hero";
import { AboutSection } from "@/components/about-section";
import { FeaturesSection } from "@/components/features-section";
import { AgentsPreview } from "@/components/agents/agents-preview";
import { Pricing } from "@/components/pricing";
import { CTA } from "@/components/cta";
import { usePageTitle } from "@/hooks/use-page-title";

/**
 * The landing page.
 *
 * The order alternates ground on purpose — footage, cream, ink, cream, ink,
 * footage. Two cream sections in a row read as one long section and the reader
 * loses their place in it.
 */
export function Home() {
  usePageTitle();

  return (
    <>
      <Hero />
      <AboutSection />
      <FeaturesSection />
      <AgentsPreview />
      <Pricing />
      <CTA />
    </>
  );
}
