// Supported display currencies. The canonical / enforced currency is
// always USD (see lib/engine/governance/guard.ts) — every entry here is
// for input + display only.
//
// `country` is the ISO-3166 alpha-2 code used by the flag-icons SVG set
// (so an Indian rupee shows 🇮🇳 — SVG, not OS-dependent emoji). The EU is
// represented by 'eu' which flag-icons treats as the European Union flag.
//
// Adding a currency:
//   1. Add an entry below with code (ISO-4217), country, symbol, name.
//   2. Add a fallback rate to FALLBACK_USD_RATES in lib/fx.ts.
// No DB migration needed — budgets.display_currency is free-form text
// validated against this list at save time.

export interface Currency {
  /** ISO-4217 alpha-3 code, uppercased. The DB stores this. */
  readonly code: string;
  /** Human-readable name. */
  readonly name: string;
  /** Display symbol, e.g. "$", "₹", "€", "¥". */
  readonly symbol: string;
  /** ISO-3166 alpha-2 country code used by the SVG flag-icons set. */
  readonly country: string;
  /** Decimal places for display. Yen / etc. use 0. */
  readonly decimals: 0 | 2;
}

export const CURRENCIES: readonly Currency[] = [
  { code: 'USD', name: 'US Dollar',        symbol: '$',  country: 'us', decimals: 2 },
  { code: 'EUR', name: 'Euro',             symbol: '€',  country: 'eu', decimals: 2 },
  { code: 'GBP', name: 'British Pound',    symbol: '£',  country: 'gb', decimals: 2 },
  { code: 'INR', name: 'Indian Rupee',     symbol: '₹',  country: 'in', decimals: 2 },
  { code: 'JPY', name: 'Japanese Yen',     symbol: '¥',  country: 'jp', decimals: 0 },
  { code: 'AUD', name: 'Australian Dollar',symbol: 'A$', country: 'au', decimals: 2 },
  { code: 'CAD', name: 'Canadian Dollar',  symbol: 'C$', country: 'ca', decimals: 2 },
  { code: 'SGD', name: 'Singapore Dollar', symbol: 'S$', country: 'sg', decimals: 2 },
  { code: 'AED', name: 'UAE Dirham',       symbol: 'AED',country: 'ae', decimals: 2 },
  { code: 'CNY', name: 'Chinese Yuan',     symbol: '¥',  country: 'cn', decimals: 2 },
  { code: 'CHF', name: 'Swiss Franc',      symbol: 'CHF',country: 'ch', decimals: 2 },
  { code: 'BRL', name: 'Brazilian Real',   symbol: 'R$', country: 'br', decimals: 2 },
  { code: 'ZAR', name: 'South African Rand',symbol: 'R', country: 'za', decimals: 2 },
  { code: 'NZD', name: 'New Zealand Dollar',symbol: 'NZ$',country:'nz', decimals: 2 },
  { code: 'KRW', name: 'South Korean Won', symbol: '₩',  country: 'kr', decimals: 0 },
  { code: 'MXN', name: 'Mexican Peso',     symbol: 'MX$',country: 'mx', decimals: 2 },
];

const BY_CODE = new Map<string, Currency>(
  CURRENCIES.map((c) => [c.code, c]),
);

export function getCurrency(code: string): Currency {
  return BY_CODE.get(code.toUpperCase()) ?? BY_CODE.get('USD')!;
}

export function isSupportedCurrency(code: string): boolean {
  return BY_CODE.has(code.toUpperCase());
}

/**
 * Format a numeric amount for display with the currency's symbol +
 * locale-aware separators. Always rounds to the currency's decimals.
 */
export function formatCurrency(amount: number, code: string): string {
  const c = getCurrency(code);
  const fixed = Number.isFinite(amount) ? amount : 0;
  // Use Intl when available for nice thousands separators; fall back to
  // a manual format. Decimals come from the currency definition.
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: c.code,
      maximumFractionDigits: c.decimals,
      minimumFractionDigits: c.decimals,
    }).format(fixed);
  } catch {
    return c.symbol + ' ' + fixed.toFixed(c.decimals);
  }
}
