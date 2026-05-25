'use client';

// SVG-flag currency picker. Uses flag-icons CSS classes (.fi.fi-<cc>) so
// flags render identically on Windows / Mac / Linux — emoji flags don't
// render on Windows out of the box.

import { CURRENCIES, getCurrency } from '@/lib/currencies';

interface Props {
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  id?: string;
  // Optional: hide rarely-used currencies by passing a subset.
  only?: ReadonlyArray<string>;
}

export function CurrencyPicker({ value, onChange, disabled, id, only }: Props) {
  const list = only
    ? CURRENCIES.filter((c) => only.includes(c.code))
    : CURRENCIES;
  const selected = getCurrency(value);

  return (
    <label
      className={
        'flex items-center gap-1.5 rounded-lg border border-white/10 bg-black/40 px-2 py-1 transition focus-within:border-forge-amber/60 focus-within:ring-2 focus-within:ring-forge-amber/30 ' +
        (disabled ? 'opacity-60' : '')
      }
    >
      <span
        aria-hidden
        // .fi is the base class; .fi-<cc> selects the country. The `fis`
        // modifier renders a squared 1:1 flag which suits a chip nicely.
        className={'fi fis fi-' + selected.country + ' h-4 w-4 shrink-0 rounded-sm'}
      />
      <select
        id={id}
        value={selected.code}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none bg-transparent font-mono text-xs text-forge-text focus:outline-none"
        aria-label="currency"
      >
        {list.map((c) => (
          <option key={c.code} value={c.code} className="bg-forge-deep text-forge-text">
            {c.code} · {c.symbol}
          </option>
        ))}
      </select>
    </label>
  );
}

// Read-only version for places where we just want to label an amount with
// its currency (e.g. the spend meter header).
export function CurrencyBadge({ code }: { code: string }) {
  const c = getCurrency(code);
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-black/30 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.25em] text-forge-dim">
      <span aria-hidden className={'fi fis fi-' + c.country + ' h-3 w-3 rounded-sm'} />
      {c.code}
    </span>
  );
}
