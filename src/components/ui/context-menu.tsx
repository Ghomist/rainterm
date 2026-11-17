import { ChevronRight } from "lucide-react";
import { ContextMenu as CM } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

const ContextMenu = CM.Root;
const ContextMenuTrigger = CM.Trigger;

function ContextMenuContent({ className, ...props }: React.ComponentProps<typeof CM.Content>) {
  return (
    <CM.Portal>
      <CM.Content
        className={cn(
          "z-50 min-w-40 overflow-hidden rounded-lg border border-ov/10 bg-popover p-1 text-popover-foreground shadow-xl shadow-shadow",
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 duration-100",
          className,
        )}
        {...props}
      />
    </CM.Portal>
  );
}

function ContextMenuItem({
  className,
  destructive,
  ...props
}: React.ComponentProps<typeof CM.Item> & { destructive?: boolean }) {
  return (
    <CM.Item
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] outline-none select-none data-[highlighted]:bg-accent [&_svg]:size-3.5 [&_svg]:text-muted-foreground",
        destructive && "text-destructive data-[highlighted]:bg-destructive/15 [&_svg]:text-destructive",
        className,
      )}
      {...props}
    />
  );
}

function ContextMenuSeparator(props: React.ComponentProps<typeof CM.Separator>) {
  return <CM.Separator className="my-1 h-px bg-border" {...props} />;
}

function ContextMenuSub(props: React.ComponentProps<typeof CM.Sub>) {
  return <CM.Sub {...props} />;
}

function ContextMenuSubTrigger({ className, children, ...props }: React.ComponentProps<typeof CM.SubTrigger>) {
  return (
    <CM.SubTrigger
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] outline-none select-none data-[highlighted]:bg-accent data-[state=open]:bg-accent [&_svg]:size-3.5 [&_svg]:text-muted-foreground",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto" />
    </CM.SubTrigger>
  );
}

function ContextMenuSubContent({ className, ...props }: React.ComponentProps<typeof CM.SubContent>) {
  return (
    <CM.Portal>
      <CM.SubContent
        sideOffset={4}
        className={cn(
          "z-50 max-h-72 min-w-36 overflow-y-auto rounded-lg border border-ov/10 bg-popover p-1 text-popover-foreground shadow-xl shadow-shadow",
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 duration-100",
          className,
        )}
        {...props}
      />
    </CM.Portal>
  );
}

export {
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
};
