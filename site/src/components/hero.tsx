import { Link } from "react-router-dom";
import { MEDIA } from "@/data/media";

/**
 * The opening screen.
 *
 * `mb-[-25px]` is load-bearing rather than a nudge: the cream section below
 * carries a 25px top radius, and pulling it up by exactly that much is what
 * makes the curve read as the cream lifting over the footage instead of a
 * rounded box parked below it.
 *
 * The scrim is 20% black and nothing more. The copy sits at the bottom of the
 * frame where the footage is darkest, so a heavier wash would flatten the
 * video for contrast that is already there.
 */
export function Hero() {
  return (
    <section id="top" className="relative h-screen overflow-hidden mb-[-25px]">
      <video
        className="absolute inset-0 w-full h-full object-cover cinematic-media"
        src={MEDIA.hero}
        autoPlay
        loop
        muted
        playsInline
        preload="auto"
        aria-hidden="true"
      />
      <div className="absolute inset-0 bg-black/20" />

      <div className="relative z-10 h-full flex flex-col justify-end px-6 pb-12 md:pb-16">
        <h1 className="text-center text-5xl sm:text-7xl md:text-8xl lg:text-[96px] font-normal text-white leading-[1.1] tracking-tight">
          Agents that really
          <br />
          act,{" "}
          {/* `not-italic` is not a contradiction: Instrument Serif ships italic
              as a real cut, so the slant must come from the font file and not
              from the browser faux-slanting an upright one. */}
          <em className="not-italic accent-serif">on the wire</em>
        </h1>

        <p className="mt-6 mx-auto max-w-[420px] text-center text-white/80 text-sm md:text-base font-medium">
          Four production agents on one metered marketplace — every call paid
          as it runs, every result carrying a receipt.
        </p>

        <div className="mt-8 mx-auto bg-black/25 backdrop-blur-md rounded-xl flex items-center pl-6 pr-1 py-1">
          <p className="hidden sm:block text-white text-sm font-medium">
            No seats. No subscription. Just work that really happened.
          </p>
          <p className="sm:hidden text-white text-sm font-medium">
            No seats. Just work that really happened.
          </p>
          <Link
            to="/agents"
            className="ml-4 shrink-0 bg-white text-black text-sm font-medium px-5 py-2.5 rounded-xl hover:bg-white/90 transition-colors"
          >
            Browse agents
          </Link>
        </div>
      </div>
    </section>
  );
}
