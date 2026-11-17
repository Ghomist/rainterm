// Overlay scrollbars (Radix ScrollArea): they float above the content, take no layout
// space, and only show while hovering / scrolling.
import { ScrollArea as SA } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

function ScrollArea({
  className,
  viewportClassName,
  viewportRef,
  children,
  orientation = "vertical",
  ...viewportProps
}: Omit<React.ComponentProps<"div">, "ref"> & {
  viewportClassName?: string;
  viewportRef?: React.Ref<HTMLDivElement>;
  orientation?: "vertical" | "horizontal" | "both";
}) {
  return (
    <SA.Root type="hover" scrollHideDelay={500} className={cn("relative overflow-hidden", className)}>
      <SA.Viewport
        ref={viewportRef}
        className={cn("size-full rounded-[inherit] outline-none [&>div]:!block", viewportClassName)}
        {...viewportProps}
      >
        {children}
      </SA.Viewport>
      {orientation !== "horizontal" && <ScrollBar orientation="vertical" />}
      {orientation !== "vertical" && <ScrollBar orientation="horizontal" />}
    </SA.Root>
  );
}

function ScrollBar({ orientation }: { orientation: "vertical" | "horizontal" }) {
  return (
    <SA.Scrollbar
      orientation={orientation}
      className={cn(
        "z-20 flex touch-none p-px transition-opacity duration-200 select-none data-[state=hidden]:opacity-0 data-[state=visible]:opacity-100",
        orientation === "vertical" ? "h-full w-2" : "h-2 flex-col",
      )}
    >
      <SA.Thumb className="relative flex-1 rounded-full bg-ov/20 transition-colors hover:bg-ov/35" />
    </SA.Scrollbar>
  );
}

export { ScrollArea };
