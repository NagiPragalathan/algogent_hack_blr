import type { RegistryListing } from "@/lib/registry";

/**
 * The split, read from the registry rather than typed here.
 *
 * `companyBps` is what the settlement code actually divides by, so rendering
 * anything else — even the number that is true today — is a page that can
 * quietly start lying after a config change nobody thought to grep for. While
 * the registry is unread the figures are simply absent; the sentence still
 * makes sense without them, and an absent number is honest in a way a
 * placeholder is not.
 */
export function RevenueSplit({
  listing,
  error,
}: {
  listing: RegistryListing | null;
  error: string | null;
}) {
  const companyPct = listing ? listing.companyBps / 100 : null;
  const devPct = companyPct === null ? null : 100 - companyPct;

  return (
    <div className="bg-paper border border-sand rounded-3xl p-6 md:p-8">
      <p className="text-[11px] tracking-[2px] uppercase text-ink/50">
        What you keep
      </p>

      {devPct === null ? (
        <p className="text-ink text-2xl font-normal tracking-tight mt-4 leading-snug">
          The developer keeps the larger share of every call.
        </p>
      ) : (
        <>
          <p className="text-ink text-5xl font-normal tracking-tight mt-4 tabular-nums">
            {devPct}%
          </p>
          <p className="text-ink/60 text-sm mt-2">
            to you, {companyPct}% to the marketplace
            {listing ? ` · ${listing.network}` : ""}
          </p>
        </>
      )}

      <p className="text-ink/65 text-sm mt-5 leading-relaxed">
        Split at settlement, in the same atomic group as the payment — not
        invoiced later. An uneven split leaves an odd microALGO, and it goes to
        you.
      </p>

      {error && (
        <p className="text-ink/50 text-xs mt-4 leading-relaxed">
          The exact figures could not be read just now ({error}) The API applies
          them at settlement either way.
        </p>
      )}
    </div>
  );
}
