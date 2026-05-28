// THE shared atmospheric layer for the signed-in app shell — the forge's
// ambient world. CSS-only (no WebGL, no deps), mounted ONCE at the (app)
// route-group root so every app page carries the same atmosphere:
//
//   lattice grid  ·  breathing molten glow  ·  rising embers  ·  vignette
//
// Embers are the signature ambient motion — restrained (a dozen, slow),
// never a fireworks show. They reuse the SAME keyframe + deterministic-
// seed technique as the landing's CssEmbers (forge-css-ember in
// globals.css) — one ember mechanism, not a parallel implementation —
// applied page-wide instead of ringed around the hero core.
//
// pointer-events-none + fixed so it never intercepts input. The global
// prefers-reduced-motion rule in globals.css freezes the breathe + embers
// to a calm static field. This is the 2D atmosphere; the 3D ForgeScene
// (when WebGL is on) layers its signature core above it.

// Deterministic ember seeds — no Math.random() per render, so SSR and the
// client agree. Spread across the width, rising the full viewport height.
// Restraint: 12 embers, slow (9–14s), staggered.
const EMBERS: ReadonlyArray<{
  left: number; // vw position
  sway: number; // px horizontal drift
  size: number; // px
  delay: number; // ms
  duration: number; // ms
  cool?: boolean; // a few cooler embers for depth
}> = [
  { left: 8, sway: 14, size: 3, delay: 0, duration: 11800 },
  { left: 19, sway: -18, size: 4, delay: 1700, duration: 13200, cool: true },
  { left: 28, sway: 10, size: 2.5, delay: 3400, duration: 10400 },
  { left: 37, sway: -12, size: 3.5, delay: 900, duration: 12600 },
  { left: 47, sway: 20, size: 3, delay: 5200, duration: 14000 },
  { left: 55, sway: -16, size: 2.5, delay: 2600, duration: 11000 },
  { left: 63, sway: 12, size: 4, delay: 6100, duration: 12200, cool: true },
  { left: 72, sway: -20, size: 3, delay: 3900, duration: 13600 },
  { left: 80, sway: 16, size: 2.5, delay: 7400, duration: 10800 },
  { left: 88, sway: -10, size: 3.5, delay: 1300, duration: 12900 },
  { left: 94, sway: 14, size: 3, delay: 4700, duration: 11500 },
  { left: 14, sway: -14, size: 2.5, delay: 8200, duration: 13900 },
];

export function ForgeBackdrop() {
  return (
    <div
      aria-hidden
      data-testid="forge-backdrop"
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-forge-void"
    >
      {/* Lattice — densest toward the upper third, fading to the edges via
          a radial mask so it reads as depth, not wallpaper. */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            'linear-gradient(to right, rgba(255,255,255,0.028) 1px, transparent 1px),' +
            'linear-gradient(to bottom, rgba(255,255,255,0.028) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
          WebkitMaskImage:
            'radial-gradient(ellipse 90% 70% at 50% 30%, #000 0%, transparent 78%)',
          maskImage:
            'radial-gradient(ellipse 90% 70% at 50% 30%, #000 0%, transparent 78%)',
        }}
      />

      {/* Breathing molten glow — amber heat from the top, a cooler cyan
          wash from the lower-right. The amber leads (the brand's heat). */}
      <div
        className="forge-ambient-breathe absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(60% 45% at 50% -8%, rgba(255,154,77,0.10), transparent 60%),' +
            'radial-gradient(50% 45% at 88% 108%, rgba(79,212,240,0.06), transparent 60%)',
        }}
      />

      {/* Rising embers — the signature ambient motion. Same keyframe as the
          landing's CssEmbers, applied page-wide + slowed for calm. */}
      <div className="absolute inset-0">
        {EMBERS.map((e, i) => (
          <span
            key={i}
            className="forge-css-ember absolute bottom-0 block rounded-full"
            style={{
              left: e.left + 'vw',
              width: e.size + 'px',
              height: e.size + 'px',
              opacity: 0,
              background: e.cool ? 'var(--cool-cyan)' : 'var(--heat-glow)',
              boxShadow: e.cool
                ? '0 0 8px 2px rgba(79,212,240,0.45)'
                : '0 0 8px 2px rgba(255,154,77,0.55)',
              ['--ember-sway' as string]: e.sway + 'px',
              ['--ember-lift' as string]: '108vh',
              animationDelay: e.delay + 'ms',
              animationDuration: e.duration + 'ms',
            }}
          />
        ))}
      </div>

      {/* Vignette — sinks the corners into the void so content floats. */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(120% 120% at 50% 40%, transparent 55%, rgba(5,6,10,0.7) 100%)',
        }}
      />
    </div>
  );
}
