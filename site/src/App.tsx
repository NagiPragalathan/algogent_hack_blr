import { Navbar } from "@/components/navbar";
import { Hero } from "@/components/hero";
import { AgentsSection } from "@/components/agents-section";
import { Mission } from "@/components/mission";
import { Solution } from "@/components/solution";
import { Pricing } from "@/components/pricing";
import { CTA } from "@/components/cta";
import { Footer } from "@/components/footer";

export default function App() {
  return (
    <>
      <Navbar />
      <main>
        <Hero />
        <AgentsSection />
        <Mission />
        <Solution />
        <Pricing />
        <CTA />
      </main>
      <Footer />
    </>
  );
}
