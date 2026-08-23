import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

/**
 * `to` is a full path, not a bare hash: these links have to work from /agents
 * too, where "#pricing" alone would look for a section that is not on the
 * page. Routing to "/#pricing" navigates home and ScrollManager takes it the
 * rest of the way.
 */
const LINKS = [
  { label: "Agents", to: "/agents" },
  { label: "How It Works", to: "/#how-it-works" },
  { label: "Pricing", to: "/#pricing" },
];

/**
 * The floating pill.
 *
 * `fixed` rather than the absolute placement a one-screen landing page would
 * use: this site is several screens deep and has a second route with no hero
 * under it, so a bar that scrolls away would strand the visitor at the bottom
 * of the directory with no way back.
 *
 * The menu closes on three things — following a link, Escape, and a pointer
 * outside the header — because it overlays the page content and any one of
 * those alone leaves a way to get stuck behind it. Closing happens in the
 * link's own handler rather than in an effect watching the location: the click
 * IS the event that closes it, and an effect would additionally fire on every
 * unrelated navigation the bar did not cause.
 */
export function Navbar() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };

    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  return (
    <header
      ref={ref}
      className="fixed top-6 left-1/2 -translate-x-1/2 z-50 animate-fade-in-down"
    >
      <div className="bg-white rounded-full shadow-lg flex items-center gap-5 pl-6 pr-2 py-2">
        <Link
          to="/"
          onClick={() => setOpen(false)}
          className="text-lg font-bold tracking-tight text-black leading-none"
        >
          AgenticWallet.
        </Link>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Close menu" : "Open menu"}
          className="w-9 h-9 rounded-full flex flex-col items-center justify-center gap-[5px] hover:bg-black/5 transition-colors"
        >
          {/* Two bars that become an X. Both collapse to the centre first —
              the translate and the rotate share one transition, so the cross
              forms as the bars meet rather than after. */}
          <span
            className={cn(
              "block w-4 h-[1.5px] bg-black transition-transform duration-300",
              open && "translate-y-[3.25px] rotate-45",
            )}
            style={{ transitionTimingFunction: "cubic-bezier(0.77,0,0.175,1)" }}
          />
          <span
            className={cn(
              "block w-4 h-[1.5px] bg-black transition-transform duration-300",
              open && "-translate-y-[3.25px] -rotate-45",
            )}
            style={{ transitionTimingFunction: "cubic-bezier(0.77,0,0.175,1)" }}
          />
        </button>
      </div>

      {/* Kept mounted and hidden with opacity so the panel can animate out.
          pointer-events-none is what stops the invisible panel from eating
          clicks meant for the hero underneath it. */}
      <div
        className={cn(
          "absolute top-full left-0 right-0 mt-2 origin-top bg-white rounded-2xl shadow-lg p-2 transition-all duration-200 ease-out",
          open
            ? "opacity-100 scale-100 translate-y-0"
            : "opacity-0 scale-95 -translate-y-1 pointer-events-none",
        )}
      >
        <nav className="flex flex-col">
          {LINKS.map((link) => (
            <Link
              key={link.label}
              to={link.to}
              onClick={() => setOpen(false)}
              className="text-sm font-medium text-black/70 hover:text-black hover:bg-black/5 rounded-xl px-4 py-2.5 transition-colors"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
