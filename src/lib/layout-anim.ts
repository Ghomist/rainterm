// "The layout is animating" (a side panel sliding open / closed). Terminals don't refit
// their rows / columns while it runs: the UI animates on its own, the terminal is clipped
// (or shows a strip of background) for those few frames, then refits once at the end.

let active = 0;
let failsafe: ReturnType<typeof setTimeout> | undefined;
const waiting = new Set<() => void>();

export function layoutAnimating() {
  return active > 0;
}

export function beginLayoutAnimation() {
  active++;
  // Never stay "animating" if an end is missed (interrupted / unmounted animation).
  clearTimeout(failsafe);
  failsafe = setTimeout(() => {
    active = 0;
    flush();
  }, 800);
}

export function endLayoutAnimation() {
  active = Math.max(0, active - 1);
  if (active === 0) {
    clearTimeout(failsafe);
    flush();
  }
}

/** Run `fn` once the layout has settled (right away if it already has). */
export function afterLayoutAnimation(fn: () => void) {
  if (active === 0) fn();
  else waiting.add(fn);
}

function flush() {
  const fns = [...waiting];
  waiting.clear();
  for (const f of fns) f();
}
