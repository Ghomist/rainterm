// Form controls in the app's own style (no native <select>, number spinners,
// checkboxes, range sliders or datalists anywhere).
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { DropdownMenu as DM, Select as S, Slider as SL, Switch as SW } from "radix-ui";
import * as React from "react";
import { cn } from "@/lib/utils";

const fieldBase =
  "flex h-8 w-full min-w-0 items-center rounded-md border border-input bg-inset text-[13px] outline-none transition-[border-color,box-shadow] duration-150 focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50";

const popoverCls =
  "z-50 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-ov/10 bg-popover p-1 text-popover-foreground shadow-xl shadow-shadow data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1 duration-150";

const itemCls =
  "relative flex h-7 cursor-default items-center gap-2 rounded-md pr-7 pl-2 text-[12.5px] outline-none select-none data-[highlighted]:bg-accent data-[disabled]:opacity-50";

// ------------------------------------------------------------------ Select

export interface Option<T> {
  value: T;
  label: React.ReactNode;
  hint?: React.ReactNode;
}

/** Typed select: values can be numbers, strings (including "") or null. */
export function Select<T extends string | number | null>({
  value,
  options,
  onChange,
  placeholder,
  className,
  size = "md",
  disabled,
}: {
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
  placeholder?: string;
  className?: string;
  size?: "sm" | "md";
  disabled?: boolean;
}) {
  // Radix needs non-empty string values: index-encode them.
  const idx = options.findIndex((o) => o.value === value);
  return (
    <S.Root
      value={idx >= 0 ? String(idx) : undefined}
      onValueChange={(v) => onChange(options[Number(v)].value)}
      disabled={disabled}
    >
      <S.Trigger
        className={cn(
          fieldBase,
          "justify-between gap-2 px-2.5 text-left data-[placeholder]:text-muted-foreground [&>span]:truncate",
          size === "sm" && "h-7 text-[12px]",
          className,
        )}
      >
        <S.Value placeholder={placeholder ?? "Select…"} />
        <S.Icon asChild>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </S.Icon>
      </S.Trigger>
      <S.Portal>
        <S.Content position="popper" sideOffset={4} className={cn(popoverCls, "max-h-72")}>
          <S.Viewport>
            {options.map((o, i) => (
              <S.Item key={String(o.value) + i} value={String(i)} className={itemCls}>
                <S.ItemText>{o.label}</S.ItemText>
                {o.hint && <span className="ml-auto pl-3 text-[11px] text-muted-foreground">{o.hint}</span>}
                <S.ItemIndicator className="absolute right-2 flex items-center">
                  <Check className="size-3.5 text-primary" />
                </S.ItemIndicator>
              </S.Item>
            ))}
          </S.Viewport>
        </S.Content>
      </S.Portal>
    </S.Root>
  );
}

// ------------------------------------------------------------------ NumberInput

export function NumberInput({
  value,
  onChange,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
  step = 1,
  placeholder,
  className,
  autoFocus,
}: {
  value: number | null;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
}) {
  const [text, setText] = React.useState(value == null || value === 0 && placeholder ? "" : String(value));
  React.useEffect(() => {
    setText((t) => (Number(t) === value ? t : value == null || (value === 0 && placeholder) ? "" : String(value)));
  }, [value, placeholder]);
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  const bump = (d: number) => {
    const n = clamp((Number(text) || 0) + d);
    setText(String(n));
    onChange(n);
  };
  return (
    <div className={cn(fieldBase, "group pr-0 focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-ring/40", className)}>
      <input
        inputMode="numeric"
        autoFocus={autoFocus}
        value={text}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => {
          const t = e.target.value.replace(/[^\d]/g, "");
          setText(t);
          if (t !== "") onChange(clamp(Number(t)));
          else onChange(0);
        }}
        onBlur={() => text !== "" && setText(String(clamp(Number(text))))}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") {
            e.preventDefault();
            bump(step);
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            bump(-step);
          }
        }}
        className="h-full min-w-0 flex-1 bg-transparent px-2.5 tabular-nums outline-none placeholder:text-muted-foreground/70"
      />
      <div className="flex h-full w-5 shrink-0 flex-col border-l border-input opacity-60 transition-opacity group-hover:opacity-100">
        {[
          { d: step, icon: <ChevronUp className="size-3" /> },
          { d: -step, icon: <ChevronDown className="size-3" /> },
        ].map(({ d, icon }) => (
          <button
            key={d}
            type="button"
            tabIndex={-1}
            onClick={() => bump(d)}
            className="flex flex-1 items-center justify-center text-muted-foreground transition-colors hover:bg-ov/[0.07] hover:text-foreground"
          >
            {icon}
          </button>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Switch

export function Switch({
  checked,
  onChange,
  disabled,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <SW.Root
      id={id}
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      className="peer relative inline-flex h-[18px] w-8 shrink-0 cursor-default items-center rounded-full border border-transparent bg-ov/15 outline-none transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 data-[state=checked]:bg-primary"
    >
      <SW.Thumb className="pointer-events-none block size-3.5 translate-x-0.5 rounded-full bg-white shadow-sm ring-0 transition-transform duration-200 ease-[cubic-bezier(.2,.8,.2,1)] data-[state=checked]:translate-x-[15px]" />
    </SW.Root>
  );
}

// ------------------------------------------------------------------ Slider

export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
}) {
  return (
    <SL.Root
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={(v) => onChange(v[0])}
      className="relative flex h-5 w-full touch-none items-center select-none"
    >
      <SL.Track className="relative h-1 grow overflow-hidden rounded-full bg-ov/12">
        <SL.Range className="absolute h-full rounded-full bg-primary" />
      </SL.Track>
      <SL.Thumb className="block size-3.5 rounded-full border-2 border-primary bg-background shadow transition-transform duration-100 outline-none hover:scale-110 focus-visible:ring-4 focus-visible:ring-ring/30" />
    </SL.Root>
  );
}

// ------------------------------------------------------------------ ComboInput

/** Free text input with a dropdown of suggestions (replaces <datalist>). */
export function ComboInput({
  value,
  onChange,
  options,
  placeholder,
  numeric,
  className,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Option<string>[];
  placeholder?: string;
  numeric?: boolean;
  className?: string;
  autoFocus?: boolean;
}) {
  return (
    <DM.Root>
      <div className={cn(fieldBase, "pr-0 focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-ring/40", className)}>
        <input
          autoFocus={autoFocus}
          value={value}
          placeholder={placeholder}
          inputMode={numeric ? "numeric" : undefined}
          spellCheck={false}
          onChange={(e) => onChange(numeric ? e.target.value.replace(/[^\d]/g, "") : e.target.value)}
          className="h-full min-w-0 flex-1 bg-transparent px-2.5 outline-none placeholder:text-muted-foreground/70"
        />
        <DM.Trigger asChild disabled={!options.length}>
          <button
            type="button"
            tabIndex={-1}
            className="flex h-full w-7 shrink-0 items-center justify-center border-l border-input text-muted-foreground transition-colors hover:bg-ov/[0.07] hover:text-foreground disabled:opacity-30"
          >
            <ChevronDown className="size-3.5" />
          </button>
        </DM.Trigger>
      </div>
      <DM.Portal>
        <DM.Content align="end" sideOffset={4} className={cn(popoverCls, "max-h-72 min-w-44 overflow-y-auto")}>
          {options.map((o) => (
            <DM.Item key={o.value} onSelect={() => onChange(o.value)} className={itemCls}>
              <span className="truncate">{o.label}</span>
              {o.hint && <span className="ml-auto truncate pl-3 text-[11px] text-muted-foreground">{o.hint}</span>}
              {o.value === value && <Check className="absolute right-2 size-3.5 text-primary" />}
            </DM.Item>
          ))}
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}
