'use client';

// ConstellationBackground — the Aurexis Forge global backdrop. Mounted ONCE at
// the app root (app/layout.tsx) so it persists behind every page: a painted
// dark base (brand-palette directional light + vignette), a drifting starfield
// on <canvas>, and a soft-light grain layer that kills gradient banding.
//
// Sits at zIndex 0, pointer-events:none; page content lives above it (the root
// layout wraps children in a relative z-[1] layer). Respects
// prefers-reduced-motion and pauses the RAF loop while the tab is hidden.

import { useEffect, useRef, type CSSProperties } from 'react';

// blue-white / cyan / violet, as "r,g,b" strings consumed by rgba().
const PALETTE = ['150,180,255', '160,220,240', '190,170,250'];

interface Dot {
  x: number;
  y: number;
  r: number;
  a: number;
  vx: number;
  vy: number;
  tw: number;
  c: string;
}

export function ConstellationBackground() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let W = 0;
    let H = 0;
    let dpr = 1;
    let dots: Dot[] = [];
    let raf: number | null = null;

    function build() {
      if (!canvas) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.width = window.innerWidth * dpr;
      H = canvas.height = window.innerHeight * dpr;
      const count = Math.min(
        Math.round((window.innerWidth * window.innerHeight) / 14000),
        160,
      );
      dots = Array.from({ length: count }, () => ({
        x: Math.random() * W,
        y: Math.random() * H,
        r: (Math.random() * 1.3 + 0.3) * dpr,
        a: Math.random() * 0.5 + 0.15,
        vx: (Math.random() - 0.5) * 0.06 * dpr,
        vy: (Math.random() - 0.5) * 0.06 * dpr,
        tw: Math.random() * Math.PI * 2,
        c: PALETTE[(Math.random() * PALETTE.length) | 0] as string,
      }));
    }

    function paint(animate: boolean) {
      if (!ctx) return;
      ctx.clearRect(0, 0, W, H);
      for (const d of dots) {
        if (animate) {
          d.x = (d.x + d.vx + W) % W;
          d.y = (d.y + d.vy + H) % H;
          d.tw += 0.02;
        }
        const a = animate ? d.a * (0.6 + 0.4 * Math.sin(d.tw)) : d.a;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${d.c},${a})`;
        ctx.fill();
      }
    }

    function loop() {
      paint(true);
      raf = requestAnimationFrame(loop);
    }
    function start() {
      if (raf == null) loop();
    }
    function stop() {
      if (raf != null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
    }

    function onResize() {
      build();
      if (reduce) paint(false);
    }
    function onVisibility() {
      if (document.hidden) stop();
      else if (!reduce) start();
    }

    build();
    if (reduce) paint(false);
    else start();
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const fixed: CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 0,
    pointerEvents: 'none',
  };

  return (
    <>
      {/* painted dark base: soft directional light in the brand palette + vignette */}
      <div
        aria-hidden
        style={{
          ...fixed,
          background:
            'radial-gradient(58% 40% at 50% -6%, rgba(108,140,255,.16), transparent 60%),' +
            'radial-gradient(42% 32% at 84% 6%, rgba(167,139,250,.11), transparent 60%),' +
            'radial-gradient(46% 34% at 12% 20%, rgba(95,214,239,.09), transparent 60%),' +
            'radial-gradient(135% 120% at 50% 32%, transparent 56%, rgba(0,0,0,.6)),' +
            'linear-gradient(180deg, #06080f, #04050a)',
        }}
      />
      {/* drifting stars */}
      <canvas ref={ref} aria-hidden style={fixed} />
      {/* grain — kills banding on the dark gradient, adds subtle film texture */}
      <div
        aria-hidden
        style={{
          ...fixed,
          opacity: 0.05,
          mixBlendMode: 'soft-light',
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
        }}
      />
    </>
  );
}
