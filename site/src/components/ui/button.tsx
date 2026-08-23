import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Four grounds, because the page has four: near-white on footage, ink on
 * cream, sand beside it, and a glass fill for the dark sections where a solid
 * button would punch a hole in the video behind it.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        paper: "bg-paper text-ink hover:bg-paper/90 focus-visible:ring-paper",
        ink: "bg-ink text-paper hover:bg-ink-strong focus-visible:ring-ink",
        sand: "bg-sand text-ink hover:bg-sand-strong focus-visible:ring-ink",
        glass:
          "bg-black/25 backdrop-blur-md text-paper hover:bg-black/40 focus-visible:ring-paper",
        outline:
          "border border-ink/25 text-ink hover:bg-ink/5 focus-visible:ring-ink",
        ghost: "text-paper/70 hover:text-paper",
      },
      size: {
        default: "h-11 px-6",
        sm: "h-9 px-4",
        lg: "h-12 px-8",
        icon: "h-10 w-10",
      },
      shape: {
        pill: "rounded-full",
        box: "rounded-xl",
      },
    },
    defaultVariants: { variant: "paper", size: "default", shape: "box" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, shape, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size, shape, className }))}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
