// Diverging green - neutral - red scale centered at zero.
// Negative values (net biogenic storage) -> green, positive (emissions) -> red.
const GREEN_DEEP = [0.05, 0.42, 0.20];
const GREEN_MID = [0.42, 0.74, 0.45];
const NEUTRAL = [0.93, 0.92, 0.86];
const RED_MID = [0.95, 0.55, 0.36];
const RED_DEEP = [0.70, 0.09, 0.09];

const lerp = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
const ramp = (mid, deep, t) => (t < 0.5 ? lerp(NEUTRAL, mid, t * 2) : lerp(mid, deep, (t - 0.5) * 2));

/** t in [-1, 1] -> [r, g, b] in 0..1 (sRGB) */
export function divergingColor(t) {
  t = Math.max(-1, Math.min(1, t));
  return t < 0 ? ramp(GREEN_MID, GREEN_DEEP, -t) : ramp(RED_MID, RED_DEEP, t);
}

export function cssColor(t) {
  const [r, g, b] = divergingColor(t);
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
}

export function gradientCSS() {
  const stops = [];
  for (let i = 0; i <= 10; i++) stops.push(cssColor(-1 + i / 5));
  return `linear-gradient(90deg, ${stops.join(',')})`;
}

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}
