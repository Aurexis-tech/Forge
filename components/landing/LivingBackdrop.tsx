'use client';

// One living-backdrop primitive, reused by:
//   - the public landing hero (variant="hero")     — full intensity
//   - the authenticated app shell (variant="ambient") — dialled down
//
// Composes the landing's CSS primitives — a molten glow disc with a
// breathing pulse, two depth-parallax rings, a passive rAF-throttled
// cursor parallax, and the CSS embers ring — into a single layer that
// works on every browser (no WebGL required). The shared keyframes
// (forge-breathe, forge-css-ember) live in app/globals.css and are
// neutralised by the global prefers-reduced-motion rule there.
//
// The brief that introduced this said: "REUSE the background
// primitives the landing already has ... do NOT write a third parallel
// implementation." This is the single home for that CSS path. The
// landing-hero's WebGL Embers (components/landing/Embers.tsx) is its
// 3D twin and only mounts inside the hero Canvas; outside the hero
// the WebGL world is handled by components/ForgeScene.tsx.

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { CssEmbers } from './CssEmbers';

type Variant = 'hero' | 'ambient';

interface Props {
  variant: Variant;
  /**
   * Routes whose own focal element makes a centred backdrop core feel
   * redundant. On these routes the breathing glow + rings are
   * suppressed, but the aurora-friendly background (embers + parallax)
   * stays so the page still has depth. The match is a startsWith on
   * pathname; default empty.
   */
  suppressCoreOnPaths?: ReadonlyArray<string>;
}

interface VariantConfig {
  // Overall opacity — ambient should never compete with foreground text.
  opacity: number;
  // Disc size (in vmin) — smaller on ambient so it doesn't bloom over text.
  discVmin: number;
  // Box-shadow blur on the disc — softer ambient glow.
  glowBlur: number;
  // Cursor parallax amplitude (px). Hero is more responsive than ambient.
  parallaxAmp: number;
  // CssEmbers ring radius.
  emberRadiusVmin: number;
  // A faint dark scrim under the layer to guarantee AA contrast on
  // text-heavy app pages. The landing hero doesn't need this because
  // its content uses its own glass panels.
  scrim: boolean;
}

const CONFIG: Record<Variant, VariantConfig> = {
  hero: {
    opacity: 1,
    discVmin: 42,
    glowBlur: 140,
    parallaxAmp: 12,
    emberRadiusVmin: 20,
    scrim: false,
  },
  ambient: {
    // 0.38 was tuned to keep AA contrast on the governance numbers + the
    // settings token fields when measured over a `text-forge-dim` body
    // paragraph at 14px on the obsidian background. The scrim below
    // provides the rest of the headroom.
    opacity: 0.38,
    discVmin: 30,
    glowBlur: 90,
    parallaxAmp: 6,
    emberRadiusVmin: 14,
    scrim: true,
  },
};

export function LivingBackdrop({
  variant,
  suppressCoreOnPaths = [],
}: Props) {
  const cfg = CONFIG[variant];

  // Pathname only used to decide whether to suppress the focal core on
  // routes that already have one (e.g. /forge). usePathname is safe in
  // the app router; returns the current pathname or '' during SSR.
  const pathname = usePathname() ?? '';
  const suppressCore = suppressCoreOnPaths.some((p) => pathname.startsWith(p));

  // Cursor parallax. Lightweight: one passive listener, one rAF per
  // frame, store offsets in CSS variables so children consume them
  // without re-rendering React.
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let raf = 0;
    let pendingX = 0;
    let pendingY = 0;
    const apply = () => {
      raf = 0;
      wrap.style.setProperty('--parallax-x', pendingX.toFixed(2) + 'px');
      wrap.style.setProperty('--parallax-y', pendingY.toFixed(2) + 'px');
    };
    const onMove = (e: MouseEvent) => {
      const { innerWidth: w, innerHeight: h } = window;
      pendingX = -((e.clientX / w) - 0.5) * cfg.parallaxAmp * 2;
      pendingY = -((e.clientY / h) - 0.5) * cfg.parallaxAmp * 2;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    return () => {
      window.removeEventListener('mousemove', onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [cfg.parallaxAmp]);

  return (
    <div
      ref={wrapRef}
      aria-hidden
      // pointer-events-none so foreground inputs/buttons receive focus
      // through the layer. The variant=ambient case is mounted by
      // FallbackShell at fixed inset-0 -z-10 already — but for the
      // hero case the parent provides positioning. We do not set z
      // here so both call sites can compose freely.
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{
        opacity: cfg.opacity,
        ['--parallax-x' as string]: '0px',
        ['--parallax-y' as string]: '0px',
      }}
    >
      {/* Molten glow disc with breathing pulse + parallax. Suppressed
          on routes that already own a focal core (so we never render
          two competing centres on the screen). */}
      {!suppressCore ? (
        <div
          className="forge-breathe absolute left-1/2 top-1/2 rounded-full"
          style={{
            width: cfg.discVmin + 'vmin',
            height: cfg.discVmin + 'vmin',
            transform:
              'translate3d(calc(-50% + var(--parallax-x)), calc(-50% + var(--parallax-y)), 0)',
            background:
              'radial-gradient(circle at 50% 50%, rgba(255,180,120,0.75) 0%, rgba(255,154,77,0.30) 35%, rgba(5,6,10,0) 72%)',
            boxShadow: '0 0 ' + cfg.glowBlur + 'px ' + Math.round(cfg.glowBlur / 5) + 'px rgba(255,154,77,0.42)',
          }}
        />
      ) : null}

      {/* Depth rings — slight inverse parallax sells the 3D illusion.
          We render them even when the core is suppressed because the
          rings are thin enough to read as ambient geometry, not a
          competing core. */}
      <div
        className="absolute left-1/2 top-1/2 rounded-full border border-forge-amber/45"
        style={{
          width: Math.round(cfg.discVmin * 0.62) + 'vmin',
          height: Math.round(cfg.discVmin * 0.62) + 'vmin',
          transform:
            'translate3d(calc(-50% + var(--parallax-x) * -0.5), calc(-50% + var(--parallax-y) * -0.5), 0)',
          opacity: suppressCore ? 0.25 : 1,
        }}
      />
      <div
        className="absolute left-1/2 top-1/2 rounded-full border border-forge-cyan/30"
        style={{
          width: Math.round(cfg.discVmin * 0.43) + 'vmin',
          height: Math.round(cfg.discVmin * 0.43) + 'vmin',
          transform:
            'translate3d(calc(-50% + var(--parallax-x) * 0.25), calc(-50% + var(--parallax-y) * 0.25), 0)',
          opacity: suppressCore ? 0.25 : 1,
        }}
      />

      {/* Rising embers — DOM-only twin of the WebGL Embers. */}
      <CssEmbers radiusVmin={cfg.emberRadiusVmin} />

      {/* AA-contrast scrim. A soft, dark, content-zone gradient that
          deepens the centre so body text (typically 12-16px on the
          obsidian void) sits on a contrast-safe field. Only enabled
          for the ambient variant — the landing hero uses its own
          glass panels for contrast. */}
      {cfg.scrim ? (
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(120% 100% at 50% 50%, rgba(5,6,10,0.55) 0%, rgba(5,6,10,0.25) 45%, rgba(5,6,10,0) 80%)',
          }}
        />
      ) : null}
    </div>
  );
}
