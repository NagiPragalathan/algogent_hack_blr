import { useEffect, useRef } from "react";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { LogoMark } from "@/components/logo-mark";
import { fadeUp, pressable } from "@/lib/motion";

const HLS_SRC =
  "https://stream.mux.com/8wrHPCX2dC3msyYU9ObwqNdm00u3ViXvOSHUMRYSEe5Q.m3u8";

/**
 * Safari plays HLS natively and hls.js explicitly reports itself unsupported
 * there, so the native path is not a fallback for a failure — it is the
 * correct road on that browser. Checking `isSupported()` first keeps the
 * Media Source path off Safari, where attaching it fights the native player.
 *
 * The instance must be destroyed on unmount: an orphaned Hls keeps pulling
 * segments for the life of the page, which on a landing page means a
 * background download that never stops.
 *
 * hls.js is ~400kB and this section is the last on the page, so it is imported
 * dynamically — the hero must not wait on a player for footage nobody has
 * scrolled to. `cancelled` is what makes that safe: the import settles after
 * an await, by which point the component may already be gone, and attaching to
 * a detached video is a leak the destroy() below would never run for.
 */
function useHlsBackground(src: string) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;

    let cancelled = false;
    let teardown: (() => void) | undefined;

    void (async () => {
      const { default: Hls } = await import("hls.js");
      if (cancelled || !video.isConnected) return;

      if (Hls.isSupported()) {
        const hls = new Hls({ enableWorker: true });
        hls.loadSource(src);
        hls.attachMedia(video);
        // Autoplay can still be refused (a data-saver profile, a policy); the
        // overlay and the copy above it do not depend on the video playing.
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          void video.play().catch(() => {});
        });
        teardown = () => hls.destroy();
        return;
      }

      if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = src;
        const onLoad = () => void video.play().catch(() => {});
        video.addEventListener("loadedmetadata", onLoad);
        teardown = () => video.removeEventListener("loadedmetadata", onLoad);
      }
    })();

    return () => {
      cancelled = true;
      teardown?.();
    };
  }, [src]);

  return ref;
}

export function CTA() {
  const videoRef = useHlsBackground(HLS_SRC);

  return (
    <section className="relative py-32 md:py-44 px-8 md:px-28 border-t border-border/30 overflow-hidden">
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-cover z-0 cinematic-media"
        muted
        loop
        playsInline
        aria-hidden="true"
      />
      <div className="absolute inset-0 bg-background/45 z-[1]" />

      <div className="relative z-10 max-w-3xl mx-auto text-center">
        <motion.div {...fadeUp(0)} className="flex justify-center">
          <LogoMark outer="w-10 h-10" inner="w-5 h-5" />
        </motion.div>

        <motion.h2
          {...fadeUp(0.08)}
          className="text-4xl md:text-6xl font-medium tracking-[-1.5px] mt-8 leading-[1.1]"
        >
          Start Your{" "}
          <span className="font-serif italic font-normal">Journey</span>
        </motion.h2>

        <motion.p
          {...fadeUp(0.16)}
          className="text-muted-foreground text-lg mt-6 max-w-xl mx-auto"
        >
          Call an agent from the extension, or publish one of your own and get
          paid per request on the same rails.
        </motion.p>

        <motion.div
          {...fadeUp(0.24)}
          className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-10"
        >
          <motion.div {...pressable}>
            <Button shape="box" className="px-8 py-3.5 h-auto">
              Start calling agents
            </Button>
          </motion.div>
          <motion.div {...pressable}>
            <Button variant="glass" shape="box" className="px-8 py-3.5 h-auto">
              Publish an agent
            </Button>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
