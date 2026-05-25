// CSS-only rising embers for the WebGL-off fallback. The 3D `Embers`
// component (components/landing/Embers.tsx) only exists inside the
// react-three-fiber canvas; this is its DOM twin so visitors who browse
// with WebGL disabled (or are on a device that doesn't have it) still
// see the hero as visibly alive — which is the brief.
//
// Cheap: a deterministic set of absolutely-positioned divs, each with a
// CSS keyframe that lifts it from below the core to above + fades out,
// with staggered delays + a horizontal sway. Roughly 16 particles is
// enough to read as embers without flooding the DOM. The global
// prefers-reduced-motion rule in app/globals.css collapses the
// animations automatically; the dots remain in place as a quiet ring.

const COUNT = 16;

// Deterministic-but-varied seeds for x/scale/delay so SSR matches the
// client render — no Math.random() per render. The keyframe handles the
// lift; the seed only shifts where each ember starts horizontally and
// when it spawns.
const SEEDS: Array<{ x: number; sway: number; scale: number; delay: number; duration: number }> = [
  { x: -32, sway:  10, scale: 1.0, delay:   0, duration: 5200 },
  { x:  28, sway: -14, scale: 0.8, delay: 320, duration: 5800 },
  { x: -12, sway:  18, scale: 1.1, delay: 640, duration: 4700 },
  { x:  46, sway: -10, scale: 0.7, delay: 980, duration: 6100 },
  { x: -52, sway:  12, scale: 0.9, delay:1280, duration: 5500 },
  { x:  14, sway: -16, scale: 1.0, delay:1620, duration: 5000 },
  { x:  38, sway:  14, scale: 0.8, delay:1900, duration: 5700 },
  { x: -22, sway: -12, scale: 1.0, delay:2240, duration: 6200 },
  { x:   4, sway:  20, scale: 0.6, delay:2540, duration: 4900 },
  { x:  56, sway: -18, scale: 1.1, delay:2820, duration: 5400 },
  { x: -42, sway:  16, scale: 0.9, delay:3160, duration: 5900 },
  { x:  20, sway: -14, scale: 0.7, delay:3480, duration: 6000 },
  { x: -16, sway:  12, scale: 1.0, delay:3800, duration: 5300 },
  { x:  32, sway: -10, scale: 0.9, delay:4120, duration: 5600 },
  { x: -36, sway:  18, scale: 0.8, delay:4440, duration: 5100 },
  { x:  10, sway: -16, scale: 1.0, delay:4780, duration: 5800 },
];

interface Props {
  // The ring radius (in vmin) embers spawn around. Matches the disc
  // size used by the fallback core so embers ride the rim, not the
  // page.
  radiusVmin?: number;
}

export function CssEmbers({ radiusVmin = 18 }: Props) {
  if (SEEDS.length !== COUNT) {
    // Compile-time invariant — guards against drift if COUNT is bumped
    // without filling out SEEDS.
    throw new Error('CssEmbers SEEDS length must match COUNT');
  }

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {SEEDS.map((s, i) => {
        // Each ember is anchored at the canvas centre; the keyframe
        // translates it upward from below the core. The seed offsets
        // its starting horizontal position around the rim.
        const left = `calc(50% + ${s.x * (radiusVmin / 18)}px)`;
        return (
          <span
            key={i}
            className="forge-css-ember absolute block rounded-full bg-forge-amber"
            style={{
              left,
              bottom: `calc(50% - ${radiusVmin + 4}vmin)`,
              width: `${4 * s.scale}px`,
              height: `${4 * s.scale}px`,
              opacity: 0,
              boxShadow: '0 0 8px 2px rgba(255, 154, 77, 0.55)',
              ['--ember-sway' as string]: `${s.sway}px`,
              ['--ember-lift' as string]: `${radiusVmin + 22}vmin`,
              animationDelay: `${s.delay}ms`,
              animationDuration: `${s.duration}ms`,
            }}
          />
        );
      })}
    </div>
  );
}
