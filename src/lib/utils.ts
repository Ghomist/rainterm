import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const isMac = navigator.userAgent.includes("Mac");

/** 0.4s · 12s · 3m 05s · 1h 02m */
export function fmtDuration(ms: number) {
  const s = ms / 1000;
  if (s < 10) return `${Math.max(0, s).toFixed(1)}s`;
  if (s < 60) return `${Math.floor(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
