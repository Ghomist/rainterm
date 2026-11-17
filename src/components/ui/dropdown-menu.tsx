import { DropdownMenu as DM } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

const DropdownMenu = DM.Root;
const DropdownMenuTrigger = DM.Trigger;

function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof DM.Content>) {
  return (
    <DM.Portal>
      <DM.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 min-w-48 overflow-hidden rounded-lg border border-ov/10 bg-popover p-1 text-popover-foreground shadow-xl shadow-shadow",
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-1 duration-150",
          className,
        )}
        {...props}
      />
    </DM.Portal>
  );
}

function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof DM.Item>) {
  return (
    <DM.Item
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] outline-none select-none data-[highlighted]:bg-accent [&_svg]:size-3.5 [&_svg]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuLabel({ className, ...props }: React.ComponentProps<typeof DM.Label>) {
  return (
    <DM.Label
      className={cn("px-2 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}

function DropdownMenuSeparator(props: React.ComponentProps<typeof DM.Separator>) {
  return <DM.Separator className="my-1 h-px bg-border" {...props} />;
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
};
