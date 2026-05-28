import { HeatBadge } from '@/components/forge/HeatBadge';
import { formatCurrency } from '@/lib/currencies';
import { spendHeatLabel, spendHeatTone } from '@/lib/forge-heat';
import type { Budget, BudgetPeriod } from '@/lib/types';
import { CurrencyBadge } from './CurrencyPicker';

interface Props {
  period: BudgetPeriod;
  /** Canonical USD spend straight from the ledger. Always authoritative. */
  spendUsd: number;
  budget: Budget | null;
  /**
   * Pre-converted display amounts. The server (which owns the FX cache)
   * computes these once and passes them in — no client-side FX round-trip,
   * no flicker. The USD values are still shown alongside as the truth.
   */
  spendDisplay: number;
  limitDisplay: number | null;
  displayCurrency: string;
  /** Disclaimer text from lib/fx.fxSourceLabel. */
  fxNote: string;
}

export function SpendMeter({
  period,
  spendUsd,
  budget,
  spendDisplay,
  limitDisplay,
  displayCurrency,
  fxNote,
}: Props) {
  const limitUsd = budget ? Number(budget.limit_usd) : null;
  const pct =
    limitUsd && limitUsd > 0
      ? Math.min(100, (spendUsd / limitUsd) * 100)
      : 0;
  const tone = !limitUsd
    ? 'bg-forge-cyan'
    : pct >= 100
      ? 'bg-rose-400'
      : pct >= 80
        ? 'bg-amber-300'
        : 'bg-emerald-400';

  const isNonUsd = displayCurrency.toUpperCase() !== 'USD';

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-white/10 bg-black/30 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-center gap-2">
          <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
            {period} spend
          </p>
          <CurrencyBadge code={displayCurrency} />
          {/* The budget heating up: cool with headroom → ember → glow →
              molten as spend approaches and crosses the cap. */}
          <HeatBadge tone={spendHeatTone(spendUsd, limitUsd)} dot>
            {spendHeatLabel(spendUsd, limitUsd)}
          </HeatBadge>
        </div>
        <p className="font-mono text-sm text-forge-text">
          {formatCurrency(spendDisplay, displayCurrency)}
          {limitDisplay != null ? (
            <span className="text-forge-dim">
              {' '}/ {formatCurrency(limitDisplay, displayCurrency)}
            </span>
          ) : (
            <span className="text-forge-dim"> · no cap</span>
          )}
        </p>
      </div>

      <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]">
        <div
          className={'h-full transition-all ' + tone}
          style={{ width: pct + '%' }}
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-[10px] text-forge-dim">
          {limitUsd
            ? pct >= 100
              ? 'CAP REACHED — new actions blocked'
              : pct.toFixed(0) + '% of budget used'
            : 'set a cap below to bound spend'}
        </p>
        {isNonUsd ? (
          <p
            className="font-mono text-[10px] text-forge-dim/80"
            title={fxNote}
          >
            {fxNote} · ${spendUsd.toFixed(2)}
            {limitUsd != null ? ' / $' + limitUsd.toFixed(2) : ''} USD
          </p>
        ) : null}
      </div>
    </div>
  );
}
