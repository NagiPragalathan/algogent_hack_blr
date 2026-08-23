import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { PublishForm } from "@/components/publish/publish-form";
import { RevenueSplit } from "@/components/publish/revenue-split";
import { useRegistryListing } from "@/hooks/use-registry-listing";
import { usePageTitle } from "@/hooks/use-page-title";
import { fadeUp } from "@/lib/motion";

/**
 * The sell side.
 *
 * Deliberately not part of /agents: that page answers "what can I buy", this
 * one answers "how do I get paid", and the two audiences want opposite things
 * from the same catalogue. It is reached from the footer rather than the
 * navbar for the same reason — most visitors are buyers.
 *
 * The registry is read once here and handed to both children. The form works
 * without it (every rule is enforced server-side regardless); what the listing
 * buys is the real revenue split and the ids already taken, both of which are
 * worse as hardcoded values than as absent ones.
 */
export function PublishPage() {
  usePageTitle("Publish an agent");
  const { listing, error } = useRegistryListing();

  return (
    <section className="bg-cream pt-32 md:pt-40 pb-24 md:pb-32 px-6">
      <div className="max-w-6xl mx-auto">
        <motion.div {...fadeUp(0)}>
          <Link
            to="/"
            className="inline-flex items-center gap-2 text-sm text-ink/60 hover:text-ink transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to home
          </Link>
        </motion.div>

        <motion.p
          {...fadeUp(0.06)}
          className="text-xs tracking-[3px] uppercase text-ink/50 mt-10"
        >
          Publish
        </motion.p>

        <motion.h1
          {...fadeUp(0.12)}
          className="text-ink text-5xl md:text-7xl font-normal tracking-tight leading-[1.05] mt-6 max-w-4xl"
        >
          List an agent,{" "}
          <em className="not-italic accent-serif">get paid per call</em>
        </motion.h1>

        <motion.p
          {...fadeUp(0.18)}
          className="text-ink/65 text-base md:text-lg max-w-2xl mt-6 leading-relaxed"
        >
          Register the agent once with the address your share should land at.
          From then on every call against it settles on chain in one atomic
          group — your cut and the marketplace's move together with the payment,
          and the receipt points at the run that earned it.
        </motion.p>

        <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] gap-8 lg:gap-12 mt-14 items-start">
          <motion.div {...fadeUp(0.24)}>
            <PublishForm listing={listing} />
          </motion.div>

          {/* Sticky on desktop: the form runs past a screen, and the split is
              the thing a developer keeps glancing back at while filling it. */}
          <motion.div {...fadeUp(0.3)} className="lg:sticky lg:top-28">
            <RevenueSplit listing={listing} error={error} />

            <div className="bg-paper border border-sand rounded-3xl p-6 md:p-8 mt-6">
              <p className="text-[11px] tracking-[2px] uppercase text-ink/50">
                Before you publish
              </p>
              <ul className="mt-4 space-y-3 text-sm text-ink/70 leading-relaxed">
                <li>
                  The <strong className="text-ink font-medium">agent ID</strong>{" "}
                  is permanent. Payouts key on it, so it cannot be renamed
                  later.
                </li>
                <li>
                  The payout address is checked properly on the server. A
                  well-shaped address with one wrong character is caught there,
                  not here.
                </li>
                <li>
                  Re-registering an id you own updates the listing. Registering
                  one you do not own is refused, never silently repointed.
                </li>
              </ul>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
