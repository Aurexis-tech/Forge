// MoldShowcase — the public front-door gallery: four LiquidGlass cards,
// one per mold, each tinted in its accent and linking into that mold
// space. Data (examples + illustrative stats) is the PURE MOLD_SHOWCASE
// from lib/landing-demo.ts — NOT a personal library count (which would be
// fictional on a fresh account). Each card lifts + glows its accent rim on
// hover (the lift comes from LiquidGlass; the rim from group-hover here).

import Link from 'next/link';
import { LiquidGlass } from '@/components/lq/LiquidGlass';
import { MOLD_SHOWCASE, type MoldAccent } from '@/lib/landing-demo';

const DOT: Record<MoldAccent, string> = {
  aurora: 'bg-lq-aurora',
  violet: 'bg-lq-violet',
  mint: 'bg-lq-mint',
  amber: 'bg-lq-amber',
};
const TEXT: Record<MoldAccent, string> = {
  aurora: 'text-lq-aurora',
  violet: 'text-lq-violet',
  mint: 'text-lq-mint',
  amber: 'text-lq-amber',
};
// Accent rim glow on hover (Tailwind arbitrary — the lq vars don't carry
// an alpha channel, so we use explicit rgba here).
const RIM: Record<MoldAccent, string> = {
  aurora: 'group-hover:shadow-[0_0_44px_-10px_rgba(95,230,255,0.5)]',
  violet: 'group-hover:shadow-[0_0_44px_-10px_rgba(167,139,250,0.5)]',
  mint: 'group-hover:shadow-[0_0_44px_-10px_rgba(110,231,183,0.5)]',
  amber: 'group-hover:shadow-[0_0_44px_-10px_rgba(251,191,36,0.5)]',
};

export function MoldShowcase() {
  return (
    <section id="molds" className="mx-auto w-full max-w-7xl px-6 py-20 sm:px-10">
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
        {MOLD_SHOWCASE.map((card) => (
          <Link
            key={card.mold}
            href={card.href}
            className="group block h-full"
            aria-label={`Explore ${card.mold}`}
          >
            <LiquidGlass
              as="div"
              className={`flex h-full flex-col gap-4 p-6 font-ui transition-shadow duration-300 ${RIM[card.accent]}`}
            >
              <div className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={`inline-block h-2 w-2 rounded-full ${DOT[card.accent]}`}
                />
                <span
                  className={`font-code text-[10px] uppercase tracking-[0.3em] ${TEXT[card.accent]}`}
                >
                  {card.mold}
                </span>
              </div>

              <h3 className="font-ui text-2xl font-bold tracking-tight text-lq-ink">
                {card.name}
              </h3>
              <p className="text-sm leading-relaxed text-lq-ink-dim">
                {card.what}
              </p>

              <div className="my-1 h-px w-full bg-lq-line" />

              <p className="font-code text-[12px] text-lq-ink">
                {card.example}
              </p>
              <ul className="flex flex-col gap-1">
                {card.stats.map((s) => (
                  <li
                    key={s}
                    className="font-code text-[11px] text-lq-ink-faint"
                  >
                    {s}
                  </li>
                ))}
              </ul>

              <span
                className={`mt-auto pt-2 text-[12px] font-medium ${TEXT[card.accent]}`}
              >
                Explore {card.mold} →
              </span>
            </LiquidGlass>
          </Link>
        ))}
      </div>
    </section>
  );
}
