// Curated egress policy for running UNTRUSTED foreign code (Sentinel).
//
// This is the deny-all-then-minimal-allowlist config the Sentinel verification
// path passes into `provider.create({ egress })`. It is NOT applied to the
// existing Forge builder — that path runs Forge's OWN generated code with mock
// tools and stays on the provider default (internet on), so this change adds
// the capability without regressing the builder.
//
// THREAT MODEL (honor these — the allowlist is the only remaining exfil surface):
//   - Every host here is a host hostile code can phone out to. Keep the list as
//     small as the target actually needs; widen it per-target, never globally.
//   - Hostname (domain) rules implicitly open DNS — e2b auto-allows the 8.8.8.8
//     resolver for domain matching, which is itself a covert channel
//     (DNS-tunnelling). Pin to IP/CIDR where practical if a target's exfil risk
//     warrants it; otherwise treat DNS as part of the accepted surface.
//   - PROVE egress is blocked from THIS config (the firewall rules you set),
//     never from in-sandbox telemetry — e2b's firewall can let a blocked TCP
//     connect look successful inside the guest, so in-guest "it failed to
//     connect" is not proof of anything.
//
// Real Next.js + Supabase apps that use `next/font/google` will also reach
// fonts.googleapis.com / fonts.gstatic.com during `next build`; add those
// PER-TARGET only when a target needs them, and note the widened surface.

import type { SandboxEgress } from './provider';

/** npm registry — needed during `npm install` (run with `--ignore-scripts`). */
export const NPM_REGISTRY_HOST = 'registry.npmjs.org';

/** Supabase project API/auth/storage — needed at boot. Wildcard covers any ref. */
export const SUPABASE_WILDCARD_HOST = '*.supabase.co';

/**
 * Deny-all egress, allowing only the npm registry (install) and Supabase (boot).
 * The minimal allowlist for verifying a stranger's Next.js + Supabase app.
 */
export const UNTRUSTED_EGRESS: SandboxEgress = {
  allowInternetAccess: false,
  allowOut: [NPM_REGISTRY_HOST, SUPABASE_WILDCARD_HOST],
};

/** Fully air-gapped — deny ALL outbound, no exceptions. Use for steps that need
 *  no network at all (e.g. an already-installed build/boot with vendored deps). */
export const AIR_GAPPED_EGRESS: SandboxEgress = {
  allowInternetAccess: false,
};

/**
 * Pinned hardened e2b template id. CPU/memory caps are baked into a template at
 * BUILD time (e2b does NOT accept cpu/memory on create) via:
 *   e2b template build --cpu-count <n> --memory-mb <m>
 * Build a hardened template sized for `next build` against your e2b account,
 * then set SENTINEL_E2B_TEMPLATE so untrusted runs land on it. Undefined falls
 * back to the e2b base template (default ~2 vCPU / 512 MB–1 GB) — fine for the
 * spike, but pin a sized template before real verification load.
 */
export const SENTINEL_E2B_TEMPLATE: string | undefined =
  process.env.SENTINEL_E2B_TEMPLATE;
