import type * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      spellCheck={false}
      autoComplete="off"
      className={cn(
        "flex h-8 w-full min-w-0 rounded-md border border-input bg-inset px-2.5 text-[13px] outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground/70 focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: generic label primitive
    <label
      className={cn("text-xs font-medium text-muted-foreground select-none", className)}
      {...props}
    />
  );
}

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-ov/5 px-1 font-sans text-[10.5px] text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { Input, Kbd, Label };
