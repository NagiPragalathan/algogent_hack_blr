import { useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fadeUp, pressable } from "@/lib/motion";
import avatar1 from "@/assets/avatar-1.svg";
import avatar2 from "@/assets/avatar-2.svg";
import avatar3 from "@/assets/avatar-3.svg";

const HERO_VIDEO =
  "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260325_120549_0cd82c36-56b3-4dd9-b190-069cfc3a623f.mp4";

const AVATARS = [avatar1, avatar2, avatar3];

/** Where an access request is posted. Unset in a static preview build. */
const WAITLIST = import.meta.env.VITE_WAITLIST_URL as string | undefined;

type SubmitState = "idle" | "sending" | "sent" | "failed";

export function Hero() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<SubmitState>("idle");

  /**
   * With no waitlist endpoint configured this hands off to the user's own mail
   * client rather than reporting a success nothing performed — a form that
   * says "you are on the list" while posting nowhere is the one piece of a
   * landing page that must not lie.
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
    <section id="top" className="relative min-h-screen flex items-center overflow-hidden">
      <video
        className="absolute inset-0 w-full h-full object-cover cinematic-media"
        src={HERO_VIDEO}
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        aria-hidden="true"
      />
      {/* Two separate jobs, so two layers. The scrim buys contrast for the
          copy — the footage has bright frames that the subtitle would
          otherwise sit inside — while the gradient below fades the section
          into the black page, so the edge is a fade rather than a hard cut. */}
      <div className="absolute inset-0 bg-background/45" />
      <div className="absolute bottom-0 left-0 right-0 h-64 bg-gradient-to-t from-background to-transparent" />

      <div className="relative z-10 w-full px-8 md:px-28 pt-28 md:pt-32 pb-24">
        <div className="max-w-4xl mx-auto text-center">
          <motion.div
            {...fadeUp(0)}
            className="flex items-center justify-center gap-3 mb-8"
          >
            <div className="flex -space-x-2">
              {AVATARS.map((src, i) => (
                <img
                  key={src}
                  src={src}
                  alt=""
                  className="w-8 h-8 rounded-full border-2 border-background"
                  style={{ zIndex: AVATARS.length - i }}
                />
              ))}
            </div>
            <span className="text-muted-foreground text-sm">
              Agents built and run by their authors
            </span>
          </motion.div>

          <motion.h1
            {...fadeUp(0.1)}
            className="text-5xl md:text-7xl lg:text-8xl font-medium tracking-[-2px] leading-[1.05]"
          >
            Agents that really{" "}
            <span className="font-serif italic font-normal">act</span>
          </motion.h1>

          <motion.p
            {...fadeUp(0.2)}
            className="mt-6 text-lg max-w-2xl mx-auto"
            style={{ color: "hsl(var(--hero-subtitle))" }}
          >
            Four production agents on one metered marketplace. Every call is
            paid on the wire, every result carries a receipt, and nothing comes
            back that did not really happen.
          </motion.p>

          <motion.form
            {...fadeUp(0.3)}
            onSubmit={onSubmit}
            className="liquid-glass rounded-full p-2 max-w-lg mx-auto mt-10 flex items-center gap-2"
          >
            <Input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              aria-label="Email address"
              className="flex-1"
            />
            <motion.div {...pressable}>
              <Button
                type="submit"
                shape="pill"
                disabled={state === "sending"}
                className="px-8 py-3 tracking-wide"
              >
                {state === "sending" ? "SENDING" : "GET ACCESS"}
              </Button>
            </motion.div>
          </motion.form>

          {state !== "idle" && state !== "sending" && (
            <p className="mt-4 text-sm text-muted-foreground">
              {state === "sent"
                ? "Request received. We will be in touch."
                : "That did not go through. Try again, or mail access@agenticwallet.dev."}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
