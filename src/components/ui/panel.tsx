// Shared building blocks for side panels and toolbars, so every panel has the same
// rhythm: 36px header, 28px controls, 8px horizontal gutters, 28px list rows.
import { Search, X } from "lucide-react";
import type * as React from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function PanelHeader({
  title,
  icon,
  children,
  className,
}: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex h-9 shrink-0 items-center gap-0.5 pr-1.5 pl-3", className)}>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase [&_svg]:size-3.5 [&_svg]:shrink-0">
        {icon}
        <span className="truncate">{title}</span>
      </div>
      {children}
    </div>
  );
}

export const iconButtonCls =
  "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors duration-100 hover:bg-ov/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-30 [&_svg]:size-[15px]";

export function IconButton({
  tip,
  shortcut,
  active,
  danger,
  className,
  children,
  ...props
}: React.ComponentProps<"button"> & {
  tip?: React.ReactNode;
  shortcut?: string;
  active?: boolean;
  danger?: boolean;
}) {
  const btn = (
    <button
      type="button"
      className={cn(
        iconButtonCls,
        active && "bg-primary/12 text-primary hover:bg-primary/20 hover:text-primary",
        danger && "hover:bg-destructive/15 hover:text-destructive",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
  return tip || shortcut ? (
    <Tooltip content={tip} shortcut={shortcut}>
      {btn}
    </Tooltip>
  ) : (
    btn
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
  onKeyDown,
  inputRef,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  inputRef?: React.Ref<HTMLInputElement>;
  className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        spellCheck={false}
        className={fieldCls("pr-7 pl-8")}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute top-1/2 right-1.5 flex size-4.5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition hover:bg-ov/10 hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

/** Recessed 28px field used by every panel input (search, filter, path). */
export function fieldCls(extra?: string) {
  return cn(
    "h-7 w-full rounded-md border border-ov/[0.07] bg-inset text-[12.5px] outline-none transition-colors duration-100 placeholder:text-muted-foreground/60 focus:border-primary/50",
    extra,
  );
}

/** 28px list row. */
export const rowCls =
  "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] outline-none transition-colors duration-75";
