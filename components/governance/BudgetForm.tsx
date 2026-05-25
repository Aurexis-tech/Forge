'use client';

// Budget cap entry, multi-currency. The user types an amount in their
// preferred currency; the server converts to USD at SAVE TIME via
// lib/fx.toUsd and stores it in budgets.limit_usd. The governance guard
// continues to enforce against limit_usd in USD — FX is display-only.

import { useRouter } from 'next/navigation';
import { useMemo, useState, type FormEvent } from 'react';
import { getCurrency } from '@/lib/currencies';
import type { Budget, BudgetPeriod } from '@/lib/types';
import { CurrencyPicker } from './CurrencyPicker';

interface Props {
  period: BudgetPeriod;
  current: Budget | null;
  /**
   * Pre-converted display amount for the *current* budget in its
   * display_currency. Server-rendered so the input is pre-filled in the
   * user's chosen currency without a client-side FX round-trip.
   */
  currentDisplayAmount: number | null;
}

export function BudgetForm({ period, current, currentDisplayAmount }: Props) {
  const router = useRouter();
  const initialCurrency = (current?.display_currency ?? 'USD').toUpperCase();
  const [currency, setCurrency] = useState<string>(initialCurrency);
  const [limit, setLimit] = useState<string>(
    currentDisplayAmount != null
      ? formatInitial(currentDisplayAmount, initialCurrency)
      : '',
  );
  const [busy, setBusy] = useState<'save' | 'clear' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ccy = useMemo(() => getCurrency(currency), [currency]);

  async function onSave(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const value = Number(limit);
    if (!Number.isFinite(value) || value < 0) {
      setError('Enter a non-negative number.');
      return;
    }
    setBusy('save');
    try {
      const res = await fetch('/api/governance/budget', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          period,
          amount: value,
          currency: ccy.code,
          hard_cap: true,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'request failed (' + res.status + ')');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setBusy(null);
    }
  }

  async function onClear() {
    setError(null);
    setBusy('clear');
    try {
      const res = await fetch('/api/governance/budget', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ period }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'request failed (' + res.status + ')');
      setLimit('');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Clear failed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <form onSubmit={onSave} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
          {period} cap
        </span>
        <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/40 px-2 py-1">
          <span
            aria-hidden
            className="font-mono text-sm text-forge-dim"
            title={ccy.name}
          >
            {ccy.symbol}
          </span>
          <input
            type="number"
            min={0}
            step={ccy.decimals === 0 ? 1 : 0.5}
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            disabled={busy != null}
            className="w-28 bg-transparent font-mono text-sm text-forge-text focus:outline-none"
            placeholder="—"
            aria-label={period + ' cap in ' + ccy.code}
          />
        </div>
        <CurrencyPicker
          value={currency}
          onChange={setCurrency}
          disabled={busy != null}
        />
      </div>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={busy != null}
          className="rounded-lg border border-forge-amber/60 bg-forge-amber/15 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-amber transition hover:bg-forge-amber/25 disabled:opacity-60"
        >
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
        {current ? (
          <button
            type="button"
            onClick={onClear}
            disabled={busy != null}
            className="rounded-lg border border-white/10 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim transition hover:border-white/30 hover:text-forge-text disabled:opacity-60"
          >
            {busy === 'clear' ? 'Clearing…' : 'Clear cap'}
          </button>
        ) : null}
      </div>
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-2 py-1 font-mono text-[10px] text-rose-200"
        >
          {error}
        </p>
      ) : null}
    </form>
  );
}

function formatInitial(amount: number, code: string): string {
  const c = getCurrency(code);
  // Match input precision to the currency: yen → integer, most others → 2 dp.
  return c.decimals === 0
    ? String(Math.round(amount))
    : (Math.round(amount * 100) / 100).toString();
}
