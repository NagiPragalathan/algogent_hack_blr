import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * Where a navigation lands.
 *
 * A single-page app keeps the scroll position across a route change, so
 * without this, following "See all agents" from halfway down the home page
 * opens the directory already scrolled into the middle of it. Two cases, and
 * they want different behaviour:
 *
 *   no hash  — a new page, so the top of it, and instantly. `behavior: auto`
 *              would inherit the `scroll-behavior: smooth` set on <html> and
 *              animate a whole page height for a jump the visitor did not ask
 *              to watch.
 *   a hash   — a target on the page, smoothly, and only once it exists. The
 *              element is mounted in the same commit as this effect but a
 *              frame before layout has settled, so the lookup is deferred to
 *              the next frame; a missing id falls back to the top rather than
 *              leaving the visitor wherever they were.
 *
 * Under `prefers-reduced-motion` the CSS media query already flattens the
 * smooth scroll, so nothing extra is needed here.
 */
export function ScrollManager() {
  const { pathname, hash } = useLocation();

  useEffect(() => {
    if (!hash) {
      window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
      return;
    }

    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(hash.slice(1));
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      else window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    });

    return () => cancelAnimationFrame(frame);
  }, [pathname, hash]);

  return null;
}
