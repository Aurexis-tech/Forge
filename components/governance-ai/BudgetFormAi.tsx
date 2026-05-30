'use client';

// BudgetFormAi — the compact, design-study "edit cap" affordance. A small
// toggle button reveals the inline amount input + currency picker. PUT /
// DELETE wiring against /api/governance/budget is preserved byte-for-
// byte, multi-currency handling is preserved (the server converts to USD
// at save time and stores `limit_usd`; `display_currency` + display
// amount round-trip).

import { useRouter } from 'next/navigation';
import { useMemo, useState, type FormEvent } from 'react';
import { CurrencyPicker } from '@/components/governance/CurrencyPicker';
import { LiquidGlass } from '@/components/lq/LiquidGlass';
import { getCurrency } from '@/lib/currencies';
import type { Budget, BudgetPeriod } from '@/lib/types';

interface Props {
  period: BudgetPeriod;
  current: Budget | null;
  /** Pre-converted display amount; matches the prior BudgetForm prop. */
  currentDisplayAmount: number | null;
  /** Visual size — `hero` is the big monthly meter; `compact` is the
   *  secondary daily readout under it. Wiring is identical. */
  size?: 'hero' | 'compact';
}

export function BudgetFormAi({
  period,
  current,
  currentDisplayAmount,
  size = 'hero',
}: Props) {
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
  const [editing, setEditing] = useState<boolean>(false);

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
      if (!res.ok) {
        throw new Error(body.error ?? 'request failed (' + res.status + ')');
      }
      setEditing(false);
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
      if (!res.ok) {
        throw new Error(body.error ?? 'request failed (' + res.status + ')');
      }
      setLimit('');
      setEditing(false);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Clear failed.');
    } finally {
      setBusy(null);
    }
  }

  // Idle: a single tidy "edit cap" / "set cap" button.
  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className={
          'inline-flex items-center gap-1 rounded-[10px] border border-lq-line px-2.5 py-1 font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-faint transition hover:border-lq-aurora/40 hover:text-lq-aurora focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lq-aurora/60 ' +
          (size === 'hero' ? '' : 'text-[9px]')
        }
        aria-label={current ? 'edit ' + period + ' cap' : 'set ' + period + ' cap'}
      >
        {current ? 'edit cap' : 'set cap'}
      </button>
    );
  }

  return (
    <form
      onSubmit={onSave}
      className="flex flex-col gap-2 rounded-[12px] border border-lq-line bg-lq-elev-1 p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-faint">
          {period} cap
        </span>
        <div className="flex items-center gap-2 rounded-[10px] border border-lq-line bg-white/[0.04] px-2 py-1 backdrop-blur-md">
          <span
            aria-hidden
            className="font-code text-sm text-lq-ink-dim"
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
            className="w-24 bg-transparent font-code text-sm text-lq-ink focus:outline-none"
            placeholder="—"
            aria-label={period + ' cap in ' + ccy.code}
            autoFocus
          />
        </div>
        <CurrencyPicker
          value={currency}
          onChange={setCurrency}
          disabled={busy != null}
        />
      </div>
      <div className="flex items-center gap-2">
        <LiquidGlass
          as="button"
          type="submit"
          disabled={busy != null}
          variant="aurora"
          className="inline-flex items-center rounded-[10px] px-3 py-1 font-code text-[10px] uppercase tracking-[0.3em]"
        >
          {busy === 'save' ? 'saving…' : 'save cap'}
        </LiquidGlass>
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setError(null);
          }}
          disabled={busy != null}
          className="inline-flex items-center rounded-[10px] border border-lq-line px-3 py-1 font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-dim transition hover:text-lq-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lq-aurora/60"
        >
          cancel
        </button>
        {current ? (
          <button
            type="button"
            onClick={onClear}
            disabled={busy != null}
            className="ml-auto inline-flex items-center rounded-[10px] border border-lq-line px-3 py-1 font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-faint transition hover:text-lq-rose focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lq-rose/60"
          >
            {busy === 'clear' ? 'clearing…' : 'clear cap'}
          </button>
        ) : null}
      </div>
      {error ? (
        <p
          role="alert"
          className="rounded-[10px] border border-lq-rose/40 bg-lq-rose/10 px-2 py-1 font-code text-[10px] text-lq-rose"
        >
          {error}
        </p>
      ) : null}
    </form>
  );
}

function formatInitial(amount: number, code: string): string {
  const c = getCurrency(code);
  return c.decimals === 0
    ? String(Math.round(amount))
    : (Math.round(amount * 100) / 100).toString();
}
