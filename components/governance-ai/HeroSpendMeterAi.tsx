// HeroSpendMeterAi — the centerpiece monthly spend meter. Bound entirely
// to REAL fields:
//   - spendUsd from getSpendUsd(userId, 'monthly')
//   - cap from the user's `budgets` row (monthly), or null when no cap set
//   - zone via spendZone() (which reuses spendHeatTone's thresholds)
//   - display amount / currency / fxNote already converted by the page
//
// NEVER fakes a climbing spend. The bar's width is a bounded CSS
// transition (0 → real pct on mount, then static). The card's warm glow
// is a STATIC zone-tinted box-shadow — not an autoplay loop.

import { LiquidGlass } from '@/components/lq/LiquidGlass';
import { formatCurrency } from '@/lib/currencies';
import {
  formatHeroSpend,
  heroMeterTicks,
  meterFill,
  spendZone,
  type SpendColor,
} from '@/lib/governance-zones';
import type { Budget } from '@/lib/types';
import { BudgetFormAi } from './BudgetFormAi';
import styles from './governance.module.css';

interface Props {
  spendUsd: number;
  budget: Budget | null;
  spendDisplay: number;
  limitDisplay: number | null;
  displayCurrency: string;
  fxNote: string;
}

const ZONE_GLOW_CLASS: Record<SpendColor, string> = {
  mint: styles.heroGlowMint!,
  aurora: styles.heroGlowAurora!,
  amber: styles.heroGlowAmber!,
  rose: styles.heroGlowRose!,
};

const ZONE_TEXT: Record<SpendColor, string> = {
  mint: 'text-lq-mint',
  aurora: 'text-lq-aurora',
  amber: 'text-lq-amber',
  rose: 'text-lq-rose',
};

const ZONE_DOT: Record<SpendColor, string> = {
  mint: 'bg-lq-mint',
  aurora: 'bg-lq-aurora',
  amber: 'bg-lq-amber',
  rose: 'bg-lq-rose',
};

const ZONE_BORDER: Record<SpendColor, string> = {
  mint: 'border-lq-mint/40 bg-lq-mint/5',
  aurora: 'border-lq-aurora/40 bg-lq-aurora/5',
  amber: 'border-lq-amber/40 bg-lq-amber/5',
  rose: 'border-lq-rose/50 bg-lq-rose/10',
};

export function HeroSpendMeterAi({
  spendUsd,
  budget,
  spendDisplay,
  limitDisplay,
  displayCurrency,
  fxNote,
}: Props) {
  const limitUsd = budget ? Number(budget.limit_usd) : null;
  const vm = spendZone(spendUsd, limitUsd);
  const fillPct = meterFill(spendUsd, limitUsd) * 100;
  const isNonUsd = displayCurrency.toUpperCase() !== 'USD';
  const hero = formatHeroSpend(spendDisplay);
  const ticks = heroMeterTicks(limitUsd);
  const hasCap = limitUsd != null && limitUsd > 0;
  const pctOfCap = hasCap
    ? Math.min(100, Math.round((spendUsd / limitUsd!) * 100))
    : 0;
  const headroomPct = hasCap ? Math.max(0, 100 - pctOfCap) : 0;
  const remainingDisplay =
    hasCap && limitDisplay != null
      ? Math.max(0, limitDisplay - spendDisplay)
      : 0;

  return (
    <LiquidGlass
      as="div"
      className={
        'flex flex-col gap-5 p-7 font-ui ' +
        styles.heroCard +
        ' ' +
        ZONE_GLOW_CLASS[vm.color]
      }
    >
      {/* Top row: label + status badge */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <span className="font-code text-[10px] uppercase tracking-[0.35em] text-lq-ink-dim">
          Current spend · month to date
        </span>
        <span
          className={
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-code text-[10px] uppercase tracking-[0.3em] ' +
            ZONE_BORDER[vm.color] +
            ' ' +
            ZONE_TEXT[vm.color]
          }
        >
          <span
            aria-hidden
            className={'inline-block h-1.5 w-1.5 rounded-full ' + ZONE_DOT[vm.color]}
          />
          {hasCap ? vm.label + ' · ' + pctOfCap + '%' : vm.label}
        </span>
      </div>

      {/* Big spend number — dollars + half-size cents */}
      <div className="flex items-baseline gap-1">
        <span className="font-ui text-6xl font-bold tracking-[-0.02em] text-lq-ink">
          {hero.dollars}
        </span>
        <span className="font-ui text-3xl font-bold tracking-[-0.02em] text-lq-ink-dim">
          {hero.cents}
        </span>
        {isNonUsd ? (
          <span
            className="ml-3 font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-faint"
            title={fxNote}
          >
            {displayCurrency.toUpperCase()} · ${spendUsd.toFixed(2)} USD
          </span>
        ) : null}
      </div>

      {/* Sub line — cap, headroom, reset clause (reset omitted until
          derivable from real data). */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-code text-[11px] text-lq-ink-dim">
          {hasCap && limitDisplay != null ? (
            <>
              {formatCurrency(limitDisplay, displayCurrency)} monthly cap
              <span className="text-lq-ink-faint">
                {' · '}
                {headroomPct}% headroom · {formatCurrency(remainingDisplay, displayCurrency)}{' '}
                left
              </span>
            </>
          ) : (
            <span className="text-lq-ink-faint">
              no cap set — every dollar allowed through
            </span>
          )}
        </p>
        <BudgetFormAi
          period="monthly"
          current={budget}
          currentDisplayAmount={limitDisplay}
          size="hero"
        />
      </div>

      {/* The meter bar — spectrum gradient mint→aurora→amber→rose,
          filled to the REAL pct via a ONE-SHOT transition. NO infinite
          loop. */}
      <div
        className={
          styles.meterTrack + (hasCap ? '' : ' ' + styles.meterEmptyTrack)
        }
      >
        {hasCap ? (
          <div
            className={styles.meterFill + ' ' + styles.meterFillSpectrum}
            style={{ width: fillPct + '%' }}
            aria-hidden
          />
        ) : null}
      </div>

      {/* Tick marks — scaled to the real cap (or generic when no cap). */}
      <div className="flex items-center justify-between font-code text-[10px] text-lq-ink-faint">
        {ticks.map((t, i) => (
          <span key={i} className={i === ticks.length - 1 ? 'text-lq-ink-dim' : ''}>
            {t}
          </span>
        ))}
      </div>
    </LiquidGlass>
  );
}
