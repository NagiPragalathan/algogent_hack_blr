import { Hero } from "@/components/hero";
import { AboutSection } from "@/components/about-section";
import { FeaturesSection } from "@/components/features-section";
import { InstallGuide } from "@/components/install-guide";
import { AgentsPreview } from "@/components/agents/agents-preview";
import { Pricing } from "@/components/pricing";
import { CTA } from "@/components/cta";
import { usePageTitle } from "@/hooks/use-page-title";

/**
 * The landing page.
 */
export function Home() {
  usePageTitle();

  return (
    <>
      <Hero />
      <AboutSection />
      <FeaturesSection />
      <InstallGuide />
      <AgentsPreview />
      <Pricing />
      <CTA />
    </>
  );
}
