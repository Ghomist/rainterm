// The "weather" background: a rainy night seen through a window (dark themes) or a
// rainbow after the rain (light themes). One 2D canvas, drawn at ≤1.25× resolution and
// ≤30 fps, paused while the window is hidden. It sits under translucent terminals, so
// everything here is deliberately low-contrast and slow.

export interface SceneOptions {
  dark: boolean;
  /** Theme surface + accent (hex) so the scene sits in the theme's palette. */
  surface: string;
  accent: string;
  /** 0.2–1 */
  intensity: number;
  /** Draw one still frame and stop (Settings → reduce effects). */
  still: boolean;
}

type RGB = [number, number, number];

function hexRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})/i.exec(hex.trim());
  if (!m) return [24, 24, 28];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as RGB;
const css = (c: RGB, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
/** Seedable so the static scene comes out the same at every size: when the terminal area
 *  narrows, the same lights / clouds / droplets just sit closer together. */
let rng: () => number = Math.random;
const rand = (a: number, b: number) => a + rng() * (b - a);
function seeded(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
/** Counts are based on the screen, not the current area, so they don't change on resize. */
const refArea = () => Math.max(800 * 600, screen.width * screen.height);

interface Streak {
  x: number;
  y: number;
  len: number;
  v: number;
  a: number;
}
interface Drop {
  x: number;
  y: number;
  r: number;
  /** px/frame; 0 while stuck */
  vy: number;
  wait: number;
  wobble: number;
}
interface Ripple {
  x: number;
  y: number;
  t: number;
  max: number;
}

export class Scene {
  private ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private scale = 1;
  private still!: HTMLCanvasElement;
  private rainbow: HTMLCanvasElement | null = null;
  private dropSprite!: HTMLCanvasElement;
  private streaks: Streak[] = [];
  private drops: Drop[] = [];
  /** Residue left by running drops: painted once, the whole layer fades slowly. */
  private trail!: HTMLCanvasElement;
  private trailCtx!: CanvasRenderingContext2D;
  private ripples: Ripple[] = [];
  private raf = 0;
  private last = 0;
  private t = 0;
  private running = false;
  private readonly seed = Math.floor(Math.random() * 2 ** 31);

  constructor(
    private canvas: HTMLCanvasElement,
    private o: SceneOptions,
  ) {
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  setOptions(o: SceneOptions) {
    const rebuild = o.dark !== this.o.dark || o.surface !== this.o.surface || o.accent !== this.o.accent;
    const repopulate = rebuild || o.intensity !== this.o.intensity;
    this.o = o;
    if (rebuild) this.buildStatic();
    if (repopulate) this.populate();
    this.restart();
  }

  resize(cssW: number, cssH: number) {
    // Background art doesn't need full HiDPI resolution; this keeps fill-rate low.
    this.scale = Math.min(window.devicePixelRatio || 1, 1.25);
    const w = Math.max(1, Math.round(cssW * this.scale));
    const h = Math.max(1, Math.round(cssH * this.scale));
    if (w === this.w && h === this.h) return;
    const first = !this.w;
    const [fx, fy] = first ? [1, 1] : [w / this.w, h / this.h];
    this.w = w;
    this.h = h;
    this.canvas.width = w;
    this.canvas.height = h;
    this.trail = document.createElement("canvas");
    this.trail.width = w;
    this.trail.height = h;
    this.trailCtx = this.trail.getContext("2d")!;
    this.buildStatic();
    if (first) this.populate();
    else {
      // Same rain, same drops, squeezed / stretched with the area.
      for (const p of [...this.streaks, ...this.drops, ...this.ripples]) {
        p.x *= fx;
        p.y *= fy;
      }
    }
    this.restart();
  }

  dispose() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    document.removeEventListener("visibilitychange", this.onVisibility);
  }

  // ---------------------------------------------------------------- loop

  private onVisibility = () => this.restart();

  private restart() {
    cancelAnimationFrame(this.raf);
    this.running = false;
    if (!this.w) return;
    this.frame(true);
    if (this.o.still || document.hidden) return;
    this.running = true;
    this.last = performance.now();
    const fps = this.o.dark ? 30 : 24;
    const loop = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      if (now - this.last < 1000 / fps - 2) return;
      this.last = now;
      this.frame(false);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Standing water at the bottom: only in the light (after-the-rain) scene. */
  private get puddleH() {
    return this.o.dark ? 0 : Math.min(78 * this.scale, this.h * 0.13);
  }

  // ---------------------------------------------------------------- static layer

  private buildStatic() {
    if (!this.w) return;
    rng = seeded(this.seed);
    try {
      this.paintStatic();
    } finally {
      rng = Math.random;
    }
  }

  private paintStatic() {
    const { w, h } = this;
    const s = this.scale;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d")!;
    const surface = hexRgb(this.o.surface);
    const accent = hexRgb(this.o.accent);
    const ph = this.puddleH;
    this.rainbow = null;

    if (this.o.dark) {
      // Night sky behind the glass: the theme surface, a touch of blue up top.
      const sky = g.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, css(mix(surface, [30, 48, 80], 0.28)));
      sky.addColorStop(0.65, css(mix(surface, [12, 16, 26], 0.15)));
      sky.addColorStop(1, css(mix(surface, [0, 0, 0], 0.25)));
      g.fillStyle = sky;
      g.fillRect(0, 0, w, h);
      // Out-of-focus city lights.
      const palette: RGB[] = [[255, 176, 90], [255, 214, 150], [110, 190, 255], accent, [255, 120, 140]];
      const lights: { x: number; y: number; r: number; c: RGB; a: number }[] = [];
      const n = Math.round(10 + refArea() / 90000);
      for (let i = 0; i < n; i++)
        lights.push({
          x: rand(0, w),
          y: rand(h * 0.4, h * 0.95),
          r: rand(14, 60) * s,
          c: palette[Math.floor(rng() * palette.length)],
          a: rand(0.05, 0.13),
        });
      const bokeh = (x: number, y: number, r: number, col: RGB, a: number, sy = 1) => {
        g.save();
        g.translate(x, y);
        g.scale(1, sy);
        const rg = g.createRadialGradient(0, 0, 0, 0, 0, r);
        rg.addColorStop(0, css(col, a));
        rg.addColorStop(0.7, css(col, a * 0.55));
        rg.addColorStop(1, css(col, 0));
        g.fillStyle = rg;
        g.beginPath();
        g.arc(0, 0, r, 0, Math.PI * 2);
        g.fill();
        g.restore();
      };
      for (const l of lights) bokeh(l.x, l.y, l.r, l.c, l.a);
    } else {
      // After the rain: pale sky, warm light from the top right, a rainbow.
      const sky = g.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, css(mix(surface, [196, 222, 246], 0.55)));
      sky.addColorStop(0.7, css(mix(surface, [236, 242, 248], 0.25)));
      sky.addColorStop(1, css(mix(surface, [214, 226, 236], 0.35)));
      g.fillStyle = sky;
      g.fillRect(0, 0, w, h);
      const sun = g.createRadialGradient(w * 0.92, h * 0.05, 0, w * 0.92, h * 0.05, Math.max(w, h) * 0.55);
      sun.addColorStop(0, "rgba(255,246,220,0.55)");
      sun.addColorStop(1, "rgba(255,246,220,0)");
      g.fillStyle = sun;
      g.fillRect(0, 0, w, h);
      // Soft clouds.
      for (let i = 0; i < 7; i++) {
        const x = rand(0, w);
        const y = rand(0, h * 0.4);
        const r = rand(80, 200) * s;
        const cg = g.createRadialGradient(x, y, 0, x, y, r);
        cg.addColorStop(0, "rgba(255,255,255,0.35)");
        cg.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = cg;
        g.save();
        g.translate(x, y);
        g.scale(1.8, 0.6);
        g.translate(-x, -y);
        g.fillRect(x - r, y - r, r * 2, r * 2);
        g.restore();
      }
      // Puddle: slightly deeper tone with a waterline.
      const pool = g.createLinearGradient(0, h - ph, 0, h);
      pool.addColorStop(0, css(mix(surface, [170, 196, 220], 0.35), 0));
      pool.addColorStop(0.18, css(mix(surface, [170, 196, 220], 0.35), 0.55));
      pool.addColorStop(1, css(mix(surface, [150, 180, 210], 0.45), 0.75));
      g.fillStyle = pool;
      g.fillRect(0, h - ph, w, ph);
      g.fillStyle = "rgba(255,255,255,0.35)";
      g.fillRect(0, h - ph + ph * 0.16, w, Math.max(1, s));
      this.rainbow = this.buildRainbow(w, h, ph);
    }

    // Tiny droplets that stay on the glass.
    this.dropSprite = this.buildDrop();
    const tiny = Math.round(refArea() / 2600);
    for (let i = 0; i < tiny; i++) {
      const r = rand(0.6, 2.3) * s;
      g.globalAlpha = rand(0.35, 0.8);
      g.drawImage(this.dropSprite, rand(0, w), rand(0, h - ph), r * 2, r * 2);
    }
    g.globalAlpha = 1;
    this.still = c;
  }

  private buildRainbow(w: number, h: number, ph: number) {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d")!;
    const cx = w * 0.78;
    const cy = h * 1.08;
    const R = Math.max(w, h) * 0.78;
    const bw = R * 0.07;
    const bands = ["255,90,90", "255,165,80", "255,225,100", "120,210,130", "90,170,255", "120,120,230", "175,120,220"];
    const rg = g.createRadialGradient(cx, cy, R - bw, cx, cy, R + bw);
    rg.addColorStop(0, "rgba(175,120,220,0)");
    bands
      .slice()
      .reverse()
      .forEach((b, i) => rg.addColorStop(0.12 + (i / (bands.length - 1)) * 0.76, `rgba(${b},0.24)`));
    rg.addColorStop(1, "rgba(255,90,90,0)");
    g.fillStyle = rg;
    g.fillRect(0, 0, w, h);
    // Fade the arc out toward its feet and leave the waterline clean.
    g.globalCompositeOperation = "destination-in";
    const fade = g.createLinearGradient(0, 0, 0, h - ph);
    fade.addColorStop(0, "rgba(0,0,0,1)");
    fade.addColorStop(0.7, "rgba(0,0,0,0.65)");
    fade.addColorStop(1, "rgba(0,0,0,0.25)");
    g.fillStyle = fade;
    g.fillRect(0, 0, w, h - ph);
    g.clearRect(0, h - ph, w, ph);
    g.globalCompositeOperation = "source-over";
    // Its reflection in the puddle: mirrored at the waterline, squashed, faint.
    const src = document.createElement("canvas");
    src.width = w;
    src.height = h;
    src.getContext("2d")!.drawImage(c, 0, 0);
    g.save();
    g.beginPath();
    g.rect(0, h - ph, w, ph);
    g.clip();
    g.globalAlpha = 0.4;
    g.translate(0, h - ph);
    g.scale(1, -0.3);
    g.translate(0, -(h - ph));
    g.drawImage(src, 0, 0);
    g.restore();
    return c;
  }

  /** One droplet: refracted light (bright bottom, dark top rim) like a lens. */
  private buildDrop() {
    const S = 64;
    const c = document.createElement("canvas");
    c.width = c.height = S;
    const g = c.getContext("2d")!;
    const r = S / 2 - 1;
    const dark = this.o.dark;
    const body = g.createRadialGradient(S / 2, S * 0.62, 0, S / 2, S / 2, r);
    body.addColorStop(0, dark ? "rgba(210,230,255,0.22)" : "rgba(255,255,255,0.55)");
    body.addColorStop(0.75, dark ? "rgba(150,180,220,0.10)" : "rgba(220,235,250,0.30)");
    body.addColorStop(1, dark ? "rgba(0,0,0,0.30)" : "rgba(90,120,150,0.30)");
    g.fillStyle = body;
    g.beginPath();
    g.arc(S / 2, S / 2, r, 0, Math.PI * 2);
    g.fill();
    // Bright crescent at the bottom (light focused through the drop), glint top-left.
    g.strokeStyle = dark ? "rgba(220,235,255,0.35)" : "rgba(255,255,255,0.85)";
    g.lineWidth = S * 0.05;
    g.beginPath();
    g.arc(S / 2, S / 2, r * 0.82, Math.PI * 0.2, Math.PI * 0.8);
    g.stroke();
    g.fillStyle = dark ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.95)";
    g.beginPath();
    g.ellipse(S * 0.36, S * 0.33, S * 0.09, S * 0.06, -0.6, 0, Math.PI * 2);
    g.fill();
    return c;
  }

  // ---------------------------------------------------------------- moving parts

  private populate() {
    const { w, h } = this;
    if (!w) return;
    const k = this.o.intensity;
    const area = refArea();
    this.streaks = [];
    if (this.o.dark) {
      const n = Math.round((area / 6500) * k);
      for (let i = 0; i < n; i++) this.streaks.push(this.newStreak(true));
    }
    this.drops = [];
    const nd = Math.round((this.o.dark ? 8 + 22 * k : 5 + 8 * k) * Math.min(2, area / 900000 + 0.6));
    for (let i = 0; i < nd; i++) this.drops.push(this.newDrop(true));
    this.trailCtx?.clearRect(0, 0, w, h);
    this.ripples = [];
  }

  private newStreak(anywhere: boolean): Streak {
    const s = this.scale;
    const far = Math.random() < 0.6;
    return {
      x: rand(-this.w * 0.1, this.w * 1.05),
      y: anywhere ? rand(-this.h, this.h) : rand(-this.h * 0.3, -20),
      len: (far ? rand(8, 16) : rand(16, 30)) * s,
      v: (far ? rand(9, 13) : rand(14, 20)) * s,
      a: far ? rand(0.05, 0.1) : rand(0.09, 0.17),
    };
  }

  private newDrop(anywhere: boolean): Drop {
    const s = this.scale;
    return {
      x: rand(0, this.w),
      y: anywhere ? rand(0, this.h - this.puddleH) : rand(-10, this.h * 0.4),
      r: rand(2.4, this.o.dark ? 8 : 5.5) * s,
      vy: 0,
      wait: rand(30, this.o.dark ? 260 : 600),
      wobble: rand(0, 6.28),
    };
  }

  private frame(firstPaint: boolean) {
    const { ctx: g, w, h } = this;
    if (!w || !this.still) return;
    this.t++;
    const s = this.scale;
    const ph = this.puddleH;
    const k = this.o.intensity;
    g.drawImage(this.still, 0, 0);

    if (this.rainbow) {
      // A slow shimmer, not a pulse.
      g.globalAlpha = 0.8 + 0.2 * Math.sin(this.t / 90);
      g.drawImage(this.rainbow, 0, 0);
      g.globalAlpha = 1;
    }

    // Rain beyond the glass (slanted by a light wind), batched into few paths.
    if (this.streaks.length) {
      const wind = -0.16;
      g.lineCap = "round";
      g.lineWidth = Math.max(1, 1.1 * s);
      for (const [lo, hi] of [
        [0, 0.08],
        [0.08, 0.12],
        [0.12, 1],
      ]) {
        g.strokeStyle = `rgba(190,210,240,${(lo + Math.min(hi, 0.18)) / 2 + 0.03})`;
        g.beginPath();
        for (const st of this.streaks) {
          if (st.a < lo || st.a >= hi) continue;
          g.moveTo(st.x, st.y);
          g.lineTo(st.x + wind * st.len, st.y + st.len);
        }
        g.stroke();
      }
      if (!firstPaint)
        for (const st of this.streaks) {
          st.y += st.v;
          st.x += wind * st.v;
          if (st.y > h) Object.assign(st, this.newStreak(false));
        }
    } else if (!firstPaint && Math.random() < 0.02 * k && this.ripples.length < 6) {
      // After the rain: a stray drip now and then.
      this.ripples.push({ x: rand(0, w), y: rand(h - ph * 0.7, h - 6 * s), t: 0, max: rand(16, 30) * s });
    }

    // Ripples on the standing water.
    if (this.ripples.length) {
      g.lineWidth = Math.max(1, s);
      const col = this.o.dark ? "200,220,255" : "255,255,255";
      for (let i = this.ripples.length - 1; i >= 0; i--) {
        const r = this.ripples[i];
        const p = r.t / 40;
        const rx = r.max * p;
        const a = (1 - p) * (this.o.dark ? 0.22 : 0.5);
        g.strokeStyle = `rgba(${col},${a})`;
        g.beginPath();
        g.ellipse(r.x, r.y, rx, rx * 0.22, 0, 0, Math.PI * 2);
        if (rx > 6 * s) g.ellipse(r.x, r.y, rx * 0.55, rx * 0.12, 0, 0, Math.PI * 2);
        g.stroke();
        if (!firstPaint) r.t++;
        if (r.t > 40) this.ripples.splice(i, 1);
      }
    }

    // Residue left by sliding drops, fading away (one draw; the fade runs every 8 frames).
    if (!firstPaint && this.t % 8 === 0) {
      const tc = this.trailCtx;
      tc.globalCompositeOperation = "destination-out";
      tc.fillStyle = "rgba(0,0,0,0.06)";
      tc.fillRect(0, 0, w, h);
      tc.globalCompositeOperation = "source-over";
    }
    g.drawImage(this.trail, 0, 0);

    // Drops on the glass: sit still a while, then run down in a wobbly line.
    for (const d of this.drops) {
      const rh = d.r * (d.vy > 0.6 ? 1.18 : 1); // a moving drop stretches a little
      g.drawImage(this.dropSprite, d.x - d.r, d.y - rh, d.r * 2, rh * 2);
      if (firstPaint) continue;
      if (d.vy === 0) {
        if (--d.wait <= 0) d.vy = 0.15 * s;
        continue;
      }
      d.vy = Math.min(d.vy * 1.06 + 0.02 * s, (this.o.dark ? 3.2 : 1.4) * s * (d.r / (5 * s)));
      d.y += d.vy;
      d.wobble += 0.15;
      d.x += Math.sin(d.wobble) * 0.25 * s;
      if (Math.random() < 0.3) {
        const r = rand(0.6, d.r * 0.35);
        this.trailCtx.globalAlpha = 0.85;
        this.trailCtx.drawImage(this.dropSprite, d.x + rand(-1, 1) * s - r, d.y - d.r - r, r * 2, r * 2);
        this.trailCtx.globalAlpha = 1;
      }
      // Sometimes it catches on the glass again.
      if (Math.random() < 0.006) {
        d.vy = 0;
        d.wait = rand(20, 120);
      }
      if (d.y - d.r > h - ph * 0.9) Object.assign(d, this.newDrop(false));
    }
  }
}
