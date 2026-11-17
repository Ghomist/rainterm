// The one tooltip used everywhere (no native `title` attributes): same look, delay,
// animation and keyboard-shortcut rendering across the app.
import { Tooltip as TooltipPrimitive } from "radix-ui";
import type * as React from "react";
import { ACTIONS, tooltipKeys } from "@/lib/keymap";
import { cn, isMac } from "@/lib/utils";
import { useApp } from "@/store/app";

const MAC_KEYS: Record<string, string> = { Ctrl: "⌘", Shift: "⇧", Alt: "⌥" };

function TooltipProvider(props: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={450} skipDelayDuration={250} {...props} />;
}

function Tooltip({
  children,
  content,
  shortcut,
  side = "bottom",
  align = "center",
  delay,
  disabled,
}: {
  children: React.ReactNode;
  content: React.ReactNode;
  /** Space-separated keys ("Ctrl Shift T"), or an action id from lib/keymap ("files"),
   *  which shows that action's current (user-configurable) binding. */
  shortcut?: string;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  /** Override the hover delay (ms), e.g. longer for dense lists. */
  delay?: number;
  disabled?: boolean;
}) {
  const bound = useApp((s) =>
    shortcut && ACTIONS.some((a) => a.id === shortcut) ? (tooltipKeys(s.settings, shortcut) ?? "") : null,
  );
  if (bound !== null) shortcut = bound || undefined;
  if (disabled || (!content && !shortcut)) return <>{children}</>;
  return (
    <TooltipPrimitive.Root delayDuration={delay}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            "z-[95] flex max-w-72 items-center gap-2 rounded-md border border-ov/10 bg-popover px-2 py-1 text-[11.5px] leading-snug text-popover-foreground shadow-lg shadow-shadow",
            "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 duration-150",
          )}
        >
          {content && <span className="min-w-0 break-words">{content}</span>}
          {shortcut && (
            <span className="flex shrink-0 items-center gap-0.5">
              {shortcut.split(" ").map((key) => {
                const k = isMac ? (MAC_KEYS[key] ?? key) : key;
                return (
                <kbd
                  key={k}
                  className="inline-flex h-4.5 min-w-4.5 items-center justify-center rounded border border-border bg-ov/5 px-1 font-sans text-[10px] text-muted-foreground"
                >
                  {k}
                </kbd>
                );
              })}
            </span>
          )}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export { Tooltip, TooltipProvider };
