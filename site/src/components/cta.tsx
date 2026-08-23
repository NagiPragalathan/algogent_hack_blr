import { useState, type FormEvent } from "react";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { MEDIA } from "@/data/media";
import { useHls } from "@/hooks/use-hls";

/** Where an access request is posted. Unset in a static preview build. */
const WAITLIST = import.meta.env.VITE_WAITLIST_URL as string | undefined;

type SubmitState = "idle" | "sending" | "sent" | "failed";

/**
 * The closing section, and the one place the access form lives.
 *
 * The form used to sit in the hero, where it competed with the heading for the
 * one screen the footage is for. Down here it is the last thing on the page
 * and the thing every call to action above it points at — which is why the
 * section carries `id="access"`.
 */
export function CTA() {
  const videoRef = useHls(MEDIA.stream);
  const [email, setEmail] = useState("");
  const [state, setState] = useState<SubmitState>("idle");

  /**
   * With no waitlist endpoint configured this hands off to the visitor's own
   * mail client rather than reporting a success nothing performed — a form
   * that says "you are on the list" while posting nowhere is the one piece of
   * a landing page that must not lie.
   */
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!email) return;

    if (!WAITLIST) {
      window.location.href = `mailto:access@agenticwallet.dev?subject=Marketplace%20access&body=${encodeURIComponent(email)}`;
      return;
    }

    setState("sending");
    try {
      const res = await fetch(WAITLIST, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setState(res.ok ? "sent" : "failed");
    } catch {
      setState("failed");
    }
  }

  return (
    <section
      id="access"
      className="relative py-28 md:py-40 px-6 overflow-hidden bg-ink-strong scroll-mt-24"
    >
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-cover cinematic-media"
        muted
        loop
        playsInline
        aria-hidden="true"
      />
      <div className="absolute inset-0 bg-black/50" />

      <div className="relative z-10 max-w-2xl mx-auto text-center">
        <BrandMark className="w-10 h-10 text-white/80 mx-auto" />

        <h2 className="text-white text-4xl md:text-6xl font-normal tracking-tight leading-[1.1] mt-8">
          Start where the work{" "}
          <em className="not-italic accent-serif">actually happens</em>
        </h2>

        <p className="text-white/70 text-base md:text-lg mt-6 max-w-lg mx-auto font-medium">
          Call an agent from the extension, or publish one of your own and get
          paid per request on the same rails.
        </p>

        <form
          onSubmit={onSubmit}
          className="mt-10 mx-auto max-w-md bg-black/25 backdrop-blur-md rounded-xl flex items-center pl-5 pr-1 py-1"
        >
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            aria-label="Email address"
            className="flex-1 min-w-0 bg-transparent text-white text-sm placeholder:text-white/50 focus:outline-none py-2.5"
          />
          <Button
            type="submit"
            variant="paper"
            shape="box"
            disabled={state === "sending"}
            className="shrink-0 h-auto px-5 py-2.5"
          >
            {state === "sending" ? "Sending" : "Get access"}
          </Button>
        </form>

        {state !== "idle" && state !== "sending" && (
          <p className="mt-4 text-sm text-white/70">
            {state === "sent"
              ? "Request received. We will be in touch."
              : "That did not go through. Try again, or mail access@agenticwallet.dev."}
          </p>
        )}
      </div>
    </section>
  );
}
