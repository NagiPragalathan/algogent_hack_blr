import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

/**
 * Every colour is a CSS variable holding bare HSL channels, so a token can be
 * alpha-modified inline (`bg-ink/20`) without a second variable per opacity.
 * The values themselves live in src/index.css; this file only names them.
 */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        /** The calm ground. */
        cream: "hsl(var(--cream))",
        /** Type on cream, and the ground of the dark sections. */
        ink: {
          DEFAULT: "hsl(var(--ink))",
          strong: "hsl(var(--ink-strong))",
        },
        /** Near-white used for buttons and type on ink. */
        paper: "hsl(var(--paper))",
        /** Dividers, secondary buttons, hairlines on cream. */
        sand: {
          DEFAULT: "hsl(var(--sand))",
          strong: "hsl(var(--sand-strong))",
        },
        status: {
          live: "hsl(var(--status-live))",
          wait: "hsl(var(--status-wait))",
          down: "hsl(var(--status-down))",
        },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        serif: ["Instrument Serif", "ui-serif", "Georgia", "serif"],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        /** The navbar dropdown, and anything else that arrives from above. */
        "fade-in-down": {
          "0%": { opacity: "0", transform: "translateY(-8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-in-down": "fade-in-down 0.2s ease-out",
      },
    },
  },
  plugins: [animate],
} satisfies Config;
