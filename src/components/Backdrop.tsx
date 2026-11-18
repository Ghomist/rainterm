// What sits behind the terminals: nothing, the weather scene, or the user's picture.
// It fills the terminal area. Opening a side panel squeezes it toward the middle (height
// unchanged): the picture is cropped "cover"-style, the weather scene keeps its layout and
// just draws it narrower. Purely decorative: no pointer events, no focus.
import { useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { themeById } from "@/lib/term-theme";
import { Scene } from "@/lib/weather";
import { useApp, useThemeId } from "@/store/app";

export function Backdrop() {
  const kind = useApp((s) => s.settings.backdrop);
  if (kind === "none") return null;
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {kind === "weather" ? <Weather /> : <Picture />}
    </div>
  );
}

function Weather() {
  const ref = useRef<HTMLCanvasElement>(null);
  const scene = useRef<Scene | null>(null);
  const def = themeById(useThemeId());
  const intensity = useApp((s) => s.settings.weatherIntensity);
  const still = useApp((s) => s.settings.reduceEffects);
  const opts = {
    dark: def.appearance === "dark",
    surface: def.theme.background,
    accent: def.accent,
    intensity,
    still,
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sc = new Scene(el, opts);
    scene.current = sc;
    // While a side panel slides, CSS stretches the last frame (cheap, and it reads as the
    // scene being squeezed); once the size settles the scene is redrawn sharp at that size.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let sized = false;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      clearTimeout(timer);
      if (!sized) {
        sized = true;
        sc.resize(width, height);
      } else timer = setTimeout(() => sc.resize(width, height), 140);
    });
    ro.observe(el);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
      sc.dispose();
      scene.current = null;
    };
  }, []);

  useEffect(() => {
    scene.current?.setOptions(opts);
  }, [opts.dark, opts.surface, opts.accent, intensity, still]);

  return <canvas ref={ref} className="absolute inset-0 size-full" />;
}

function Picture() {
  const path = useApp((s) => s.settings.backdropImage);
  const dim = useApp((s) => s.settings.backdropDim);
  const blur = useApp((s) => s.settings.backdropBlur);
  const dark = themeById(useThemeId()).appearance === "dark";
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!path) return setUrl(null);
    let gone = false;
    let made: string | null = null;
    void ipc.backdropRead(path).then(
      (buf) => {
        if (gone) return;
        made = URL.createObjectURL(new Blob([buf]));
        setUrl(made);
      },
      () => !gone && setUrl(null),
    );
    return () => {
      gone = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [path]);

  if (!url) return null;
  return (
    <>
      <img
        src={url}
        alt=""
        draggable={false}
        className="absolute inset-0 size-full object-cover"
        // Blur bleeds transparent edges in; scale a little past them.
        style={blur ? { filter: `blur(${blur}px)`, transform: `scale(${1 + blur / 200})` } : undefined}
      />
      <div className="absolute inset-0" style={{ background: dark ? `rgba(0,0,0,${dim})` : `rgba(255,255,255,${dim})` }} />
    </>
  );
}
