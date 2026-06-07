// ============================================================================
//             TOKEN TOP-UP PACKAGES — EDIT PRICES HERE
// ============================================================================
// Purchasable bundles for the wallet. Defined in code (not the DB) so pricing
// is reviewable in a PR, matching the pricing.ts convention. Prices INCLUDE
// your platform margin — the reference value of a bundle is
// `tokens / 1e6 * TOKENS_USD_PER_MTOK` (see pricing.ts); charge above that.
//
// `price_inr` is first-class because Aurexis bills India via Razorpay; both
// currencies are carried so the UI + a future payment provider can pick one.
//
// The instant manual top-up also accepts a CUSTOM token amount (no package),
// bounded by TOPUP_MIN_TOKENS / TOPUP_MAX_TOKENS below.

import type { TokenPackage } from '@/lib/types';

export const TOKEN_PACKAGES: TokenPackage[] = [
  { id: 'starter', name: 'Starter', tokens: 1_000_000, price_usd: 10, price_inr: 799 },
  { id: 'builder', name: 'Builder', tokens: 5_000_000, price_usd: 45, price_inr: 3499, badge: 'Popular' },
  { id: 'studio', name: 'Studio', tokens: 20_000_000, price_usd: 160, price_inr: 12999 },
  { id: 'scale', name: 'Scale', tokens: 100_000_000, price_usd: 700, price_inr: 57999, badge: 'Best value' },
];

// Bounds for a custom (non-package) top-up amount.
export const TOPUP_MIN_TOKENS = 100_000;
export const TOPUP_MAX_TOKENS = 1_000_000_000;

export function findPackage(id: string): TokenPackage | undefined {
  return TOKEN_PACKAGES.find((p) => p.id === id);
}
