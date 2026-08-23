import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Deliberately chrome-free: the field lives inside a .liquid-glass shell that
 * already draws the edge, so a border here would double it.
 */
const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        "flex h-11 w-full bg-transparent px-5 text-sm text-foreground",
        "placeholder:text-muted-foreground focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export { Input };
