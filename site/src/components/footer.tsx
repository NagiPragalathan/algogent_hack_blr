import { Link } from "react-router-dom";
import { Instagram, Linkedin, Twitter } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";

const LINKS = [
  { label: "Agents", to: "/agents" },
  { label: "How It Works", to: "/#how-it-works" },
  { label: "Pricing", to: "/#pricing" },
  { label: "Publish an agent", to: "/publish" },
  { label: "Get access", to: "/#access" },
];

const SOCIALS = [
  { label: "Instagram", icon: Instagram, href: "https://instagram.com" },
  { label: "LinkedIn", icon: Linkedin, href: "https://linkedin.com" },
  { label: "X", icon: Twitter, href: "https://x.com" },
];

export function Footer() {
  return (
    <footer className="bg-ink-strong border-t border-paper/10 py-14 px-6">
      <div className="max-w-6xl mx-auto flex flex-col md:flex-row md:items-start gap-10 md:gap-16">
        <div className="shrink-0">
          <BrandMark className="w-9 h-9 text-paper/80" />
          <p className="text-paper text-lg font-bold tracking-tight mt-4">
            AgenticWallet.
          </p>
          <p className="text-paper/50 text-sm mt-1 max-w-xs leading-relaxed">
            Metered agent calls, with a receipt that points at work that really
            happened.
          </p>
        </div>

        <nav className="flex flex-col gap-3 md:ml-auto">
          {LINKS.map((link) => (
            <Link
              key={link.label}
              to={link.to}
              className="text-paper/60 text-sm hover:text-paper transition-colors"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-2">
          {SOCIALS.map(({ label, icon: Icon, href }) => (
            <a
              key={label}
              href={href}
              aria-label={label}
              target="_blank"
              rel="noreferrer"
              className="w-10 h-10 rounded-full border border-paper/15 flex items-center justify-center text-paper/60 hover:text-paper hover:border-paper/40 transition-colors"
            >
              <Icon className="w-4 h-4" strokeWidth={1.5} />
            </a>
          ))}
        </div>
      </div>

      <div className="max-w-6xl mx-auto mt-12 pt-6 border-t border-paper/10 flex flex-col sm:flex-row items-center justify-between gap-3">
        <p className="text-paper/40 text-sm">
          &copy; 2026 AgenticWallet. All rights reserved.
        </p>
        <nav className="flex items-center gap-6">
          {["Privacy", "Terms", "Contact"].map((label) => (
            <a
              key={label}
              href={`#${label.toLowerCase()}`}
              className="text-paper/40 text-sm hover:text-paper transition-colors"
            >
              {label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
