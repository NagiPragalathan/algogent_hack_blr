import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { AgentsDirectory } from "@/components/agents/agents-directory";
import { CTA } from "@/components/cta";
import { AGENTS } from "@/data/agents";
import { fadeUp } from "@/lib/motion";

/**
 * The directory — every agent, with its contract open.
 *
 * A separate route rather than an expanded section on the home page, because
 * the two answer different questions. The home page answers "is there anything
 * here for me" in one screen; this answers "exactly what does this return, and
 * what does it cost me when it fails", which is several screens of schema per
 * agent and would bury the pitch if it sat inline.
 */
export function AgentsPage() {
  return (
    <>
      <section className="pt-36 md:pt-44 pb-6 px-8 md:px-28">
        <motion.div {...fadeUp(0)}>
          <Link
            to="/"
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to home
          </Link>
        </motion.div>

        <motion.p
          {...fadeUp(0.06)}
          className="text-xs tracking-[3px] uppercase text-muted-foreground mt-10"
        >
          Directory
        </motion.p>

        <motion.h1
          {...fadeUp(0.12)}
          className="text-5xl md:text-7xl font-medium tracking-[-2px] leading-[1.05] mt-6 max-w-4xl"
        >
          Every agent,{" "}
          <span className="font-serif italic font-normal">in full</span>
        </motion.h1>

        <motion.p
          {...fadeUp(0.18)}
          className="text-muted-foreground text-lg max-w-2xl mt-6"
        >
          All {AGENTS.length} listings with the contract open: what a call
          accepts, what it returns, the codes it comes back with when it cannot
          finish, and the arithmetic behind the price. Availability is asked
          live — nothing here is presented as callable on the strength of a
          value typed into a file.
        </motion.p>
      </section>

      <section className="pb-24 md:pb-32 px-8 md:px-28">
        <AgentsDirectory />
      </section>

      <CTA />
    </>
  );
}
