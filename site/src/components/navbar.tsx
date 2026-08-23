import { Fragment, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { motion } from "framer-motion";
import { Instagram, Linkedin, Twitter } from "lucide-react";
import { LogoMark } from "@/components/logo-mark";
import { cn } from "@/lib/utils";

/**
 * `to` is a full path, not a bare hash: these links have to work from /agents
 * too, where "#pricing" alone would look for a section that is not on the
 * page. Routing to "/#pricing" navigates home and ScrollManager takes it the
 * rest of the way.
 */
const LINKS = [
  { label: "Home", to: "/" },
  { label: "Agents", to: "/agents" },
  { label: "How It Works", to: "/#how-it-works" },
  { label: "Pricing", to: "/#pricing" },
];

const SOCIALS = [
  { label: "Instagram", icon: Instagram, href: "https://instagram.com" },
  { label: "LinkedIn", icon: Linkedin, href: "https://linkedin.com" },
  { label: "X", icon: Twitter, href: "https://x.com" },
];

/**
 * Transparent over the hero and only there.
 *
 * A fill on first paint would cut a band across the footage, which is the
 * whole reason the bar is declared transparent. Past the fold it is a fixed
 * bar sitting on top of cards and body copy, and with nothing behind it the
 * logo lands on top of whatever is scrolling past — so the backdrop fades in
 * after the hero rather than being present or absent for the whole page.
 *
 * Only the home page has that hero. On every other route the backdrop is on
 * from the first frame, because there the bar starts over ordinary content and
 * the unfilled state is not a design decision, just an unreadable heading.
 *
 * The listener is passive: it only ever reads scrollY, and a non-passive
 * scroll handler blocks the compositor on a page built around scroll.
 */
export function Navbar() {
  const { pathname } = useLocation();
  const [scrolled, setScrolled] = useState(false);
  const filled = scrolled || pathname !== "/";

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <motion.header
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: "easeOut" }}
      className={cn(
        "fixed top-0 left-0 right-0 z-50 px-8 md:px-28 py-4 transition-colors duration-300",
        filled && "bg-background/80 backdrop-blur-md border-b border-border/30",
      )}
    >
      <nav className="flex items-center gap-10">
        <Link to="/" className="flex items-center gap-2.5 shrink-0">
          <LogoMark />
          <span className="font-bold tracking-tight">AgenticWallet</span>
        </Link>

        <div className="hidden md:flex items-center gap-3 text-sm">
          {LINKS.map((link, i) => (
            <Fragment key={link.label}>
              {i > 0 && <span className="text-muted-foreground/40">&bull;</span>}
              <Link
                to={link.to}
                className={cn(
                  "transition-colors hover:text-foreground",
                  link.to === pathname
                    ? "text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {link.label}
              </Link>
            </Fragment>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {SOCIALS.map(({ label, icon: Icon, href }) => (
            <a
              key={label}
              href={href}
              aria-label={label}
              target="_blank"
              rel="noreferrer"
              className="liquid-glass w-10 h-10 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
            >
              <Icon className="w-4 h-4" strokeWidth={1.5} />
            </a>
          ))}
        </div>
      </nav>
    </motion.header>
  );
}
