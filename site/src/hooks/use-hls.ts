import { useEffect, useRef } from "react";

/**
 * An HLS source attached to a <video>, on whichever road that browser has.
 *
 * Safari plays HLS natively and hls.js explicitly reports itself unsupported
 * there, so the native path is not a fallback for a failure — it is the
 * correct road on that browser. Checking `isSupported()` first keeps the Media
 * Source path off Safari, where attaching it fights the native player.
 *
 * The instance must be destroyed on unmount: an orphaned Hls keeps pulling
 * segments for the life of the page, which on a landing page means a
 * background download that never stops.
 *
 * hls.js is ~400kB, so it is imported dynamically — the hero must not wait on
 * a player for footage nobody has scrolled to. `cancelled` is what makes that
 * safe: the import settles after an await, by which point the component may
 * already be gone, and attaching to a detached video is a leak the destroy()
 * below would never run for.
 *
 * Lives in its own file because two sections now use it. It was inline in the
 * closing section, and the second caller is exactly the moment a copy would
 * have been made.
 */
export function useHls(src: string) {
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
        // Autoplay can still be refused (a data-saver profile, a policy); no
        // copy on the page depends on the video actually playing.
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
