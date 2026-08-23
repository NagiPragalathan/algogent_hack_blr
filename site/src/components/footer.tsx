const LINKS = ["Privacy", "Terms", "Contact"];

export function Footer() {
  return (
    <footer className="py-12 px-8 md:px-28 border-t border-border/30">
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
        <p className="text-muted-foreground text-sm">
          &copy; 2026 AgenticWallet. All rights reserved.
        </p>
        <nav className="flex items-center gap-6">
          {LINKS.map((label) => (
            <a
              key={label}
              href={`#${label.toLowerCase()}`}
              className="text-muted-foreground text-sm hover:text-foreground transition-colors"
            >
              {label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
