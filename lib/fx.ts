// FX conversion for the budget UI. USD is the base currency throughout.
//
// CRITICAL: the governance guard NEVER calls this module. Enforcement
// compares spend-in-USD to limit_usd directly; live rates are display
// + entry only. If this module's network call fails, the fallback table
// below ensures the app still works — just with slightly stale rates.
//
// Source: frankfurter.app (ECB-derived, no-key, daily updates). If that's
// unreachable, fall back to a static rate table updated periodically by
// the maintainer. Cached in-memory for 24h per process.

import {
  CURRENCIES,
  getCurrency,
  isSupportedCurrency,
} from './currencies';

// --- fallback static table -------------------------------------------------
// !!! UPDATE PERIODICALLY (these are approximate as of late 2025). The
// network fetch is the primary source; this only fires when the fetch
// fails. Keys are "1 USD = X <CCY>".
const FALLBACK_USD_RATES: Record<string, number> = {
  USD: 1.00,
  EUR: 0.92,
  GBP: 0.78,
  INR: 83.50,
  JPY: 155.00,
  AUD: 1.53,
  CAD: 1.36,
  SGD: 1.34,
  AED: 3.67,
  CNY: 7.25,
  CHF: 0.88,
  BRL: 5.10,
  ZAR: 18.30,
  NZD: 1.65,
  KRW: 1380.0,
  MXN: 17.20,
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FRANKFURTER_URL = 'https://api.frankfurter.app/latest?from=USD';

interface RateCache {
  fetchedAt: number;
  // 1 USD = rates[CCY]. USD itself is always 1.
  rates: Record<string, number>;
  source: 'live' | 'fallback';
}

let cache: RateCache | null = null;
let inflight: Promise<RateCache> | null = null;

interface FrankfurterResponse {
  base?: string;
  date?: string;
  rates?: Record<string, number>;
}

async function fetchFresh(): Promise<RateCache> {
  try {
    const url = new URL(FRANKFURTER_URL);
    const wanted = CURRENCIES.map((c) => c.code).filter((c) => c !== 'USD');
    url.searchParams.set('to', wanted.join(','));
    const res = await fetch(url.toString(), {
      // Server-side fetch; Next will cache the response for an hour as a
      // safety net even if our in-memory cache misses.
      next: { revalidate: 3600 },
    });
    if (!res.ok) throw new Error('http ' + res.status);
    const data = (await res.json()) as FrankfurterResponse;
    if (!data.rates) throw new Error('no rates field');
    const rates: Record<string, number> = { USD: 1 };
    for (const [code, rate] of Object.entries(data.rates)) {
      if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) {
        rates[code] = rate;
      }
    }
    // Fill any missing supported codes from the fallback so the rest of
    // the app never has to handle "rate not found".
    for (const c of CURRENCIES) {
      if (rates[c.code] == null) {
        rates[c.code] = FALLBACK_USD_RATES[c.code] ?? 1;
      }
    }
    return { fetchedAt: Date.now(), rates, source: 'live' };
  } catch {
    // Live fetch failed — use the static fallback table.
    return {
      fetchedAt: Date.now(),
      rates: { ...FALLBACK_USD_RATES },
      source: 'fallback',
    };
  }
}

async function getRates(): Promise<RateCache> {
  const fresh = cache && Date.now() - cache.fetchedAt < ONE_DAY_MS;
  if (fresh) return cache!;
  if (inflight) return inflight;
  inflight = fetchFresh().then((c) => {
    cache = c;
    inflight = null;
    return c;
  });
  return inflight;
}

// --- public API ------------------------------------------------------------

export interface FxSnapshot {
  fetchedAt: number;
  rates: Readonly<Record<string, number>>;
  source: 'live' | 'fallback';
}

export async function getFxSnapshot(): Promise<FxSnapshot> {
  const c = await getRates();
  return { fetchedAt: c.fetchedAt, rates: c.rates, source: c.source };
}

/**
 * Convert an amount in `currency` to USD. Returns the equivalent USD
 * amount as a plain number. Unsupported currencies fall through to USD
 * (1:1) rather than throwing — the caller has already validated against
 * the catalog.
 */
export async function toUsd(
  amount: number,
  currency: string,
): Promise<number> {
  if (!Number.isFinite(amount) || amount < 0) return 0;
  const code = currency.toUpperCase();
  if (!isSupportedCurrency(code) || code === 'USD') return amount;
  const c = await getRates();
  const rate = c.rates[code] ?? FALLBACK_USD_RATES[code] ?? 1;
  return amount / rate;
}

/**
 * Convert an amount in USD to `currency` for display. Mirror of toUsd.
 */
export async function fromUsd(
  amountUsd: number,
  currency: string,
): Promise<number> {
  if (!Number.isFinite(amountUsd) || amountUsd < 0) return 0;
  const code = currency.toUpperCase();
  if (!isSupportedCurrency(code) || code === 'USD') return amountUsd;
  const c = await getRates();
  const rate = c.rates[code] ?? FALLBACK_USD_RATES[code] ?? 1;
  return amountUsd * rate;
}

// Synchronous variants used by client components that have already
// received a pre-loaded snapshot via props. Hand a snapshot down from the
// server component to avoid a round-trip per UI tick.
export function toUsdFromSnapshot(
  snapshot: FxSnapshot,
  amount: number,
  currency: string,
): number {
  if (!Number.isFinite(amount) || amount < 0) return 0;
  const code = currency.toUpperCase();
  if (code === 'USD' || !isSupportedCurrency(code)) return amount;
  const rate = snapshot.rates[code] ?? FALLBACK_USD_RATES[code] ?? 1;
  return amount / rate;
}

export function fromUsdFromSnapshot(
  snapshot: FxSnapshot,
  amountUsd: number,
  currency: string,
): number {
  if (!Number.isFinite(amountUsd) || amountUsd < 0) return 0;
  const code = currency.toUpperCase();
  if (code === 'USD' || !isSupportedCurrency(code)) return amountUsd;
  const rate = snapshot.rates[code] ?? FALLBACK_USD_RATES[code] ?? 1;
  return amountUsd * rate;
}

// For UI placement of the disclaimer note.
export function fxSourceLabel(snapshot: FxSnapshot): string {
  return snapshot.source === 'live'
    ? '≈ approximate · billed in USD'
    : '≈ approximate (offline rates) · billed in USD';
}

// Re-export the currency type from `./currencies` so importers only need
// to remember one module name in the budget flow.
export { getCurrency } from './currencies';
