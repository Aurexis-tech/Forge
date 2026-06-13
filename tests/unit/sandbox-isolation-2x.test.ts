// Sandbox isolation (e2b 2.x) — prove the egress/resource CONFIG from the config
// itself, never from in-sandbox telemetry (e2b's firewall can make a blocked TCP
// connect look successful inside the guest, so in-guest observation proves
// nothing). These assert the pure SandboxCreateOptions -> e2b SandboxOpts
// translation. Hermetic: no e2b SDK, no sandbox, no network.

import { describe, expect, it } from 'vitest';
import { buildE2bCreateOptions } from '@/lib/engine/sandbox/providers/e2b';
import {
  UNTRUSTED_EGRESS,
  AIR_GAPPED_EGRESS,
  NPM_REGISTRY_HOST,
  SUPABASE_WILDCARD_HOST,
} from '@/lib/engine/sandbox/egress';

describe('e2b create-options translation — egress proven from CONFIG', () => {
  it('UNTRUSTED_EGRESS -> allowInternetAccess:false + network.allowOut = [registry, supabase]', () => {
    const o = buildE2bCreateOptions(
      { egress: UNTRUSTED_EGRESS, auth: { apiKey: 'k' } },
      'k',
    );
    // Deny all, then carve the minimal allowlist (allow rules take precedence).
    expect(o.allowInternetAccess).toBe(false);
    expect(o.network).toEqual({
      allowOut: [NPM_REGISTRY_HOST, SUPABASE_WILDCARD_HOST],
    });
  });

  it('the allowlist is MINIMAL — exactly the npm registry + Supabase, nothing else', () => {
    expect(UNTRUSTED_EGRESS.allowOut).toEqual([
      'registry.npmjs.org',
      '*.supabase.co',
    ]);
  });

  it('AIR_GAPPED_EGRESS -> allowInternetAccess:false with NO allow holes', () => {
    const o = buildE2bCreateOptions(
      { egress: AIR_GAPPED_EGRESS, auth: { apiKey: 'k' } },
      'k',
    );
    expect(o.allowInternetAccess).toBe(false);
    // No allowOut => no `network` allow-list => nothing punches through the block.
    expect(o.network).toBeUndefined();
  });

  it('REGRESSION GUARD: omitting egress leaves the builder UNRESTRICTED (e2b default internet-on)', () => {
    const o = buildE2bCreateOptions({ auth: { apiKey: 'k' } }, 'k');
    // The existing Forge builder passes no egress, so the upgrade must NOT
    // restrict it — allowInternetAccess + network stay unset (e2b default = ON).
    expect(o.allowInternetAccess).toBeUndefined();
    expect(o.network).toBeUndefined();
  });

  it('threads template + timeoutMs(lifetime) + metadata + apiKey through to e2b', () => {
    const o = buildE2bCreateOptions(
      { template: 'sentinel-hardened', lifetimeMs: 123_000, metadata: { run: 'x' } },
      'KEY',
    );
    expect(o.template).toBe('sentinel-hardened');
    expect(o.timeoutMs).toBe(123_000);
    expect(o.metadata).toEqual({ run: 'x' });
    expect(o.apiKey).toBe('KEY');
  });

  it('default lifetime is 5 minutes when none is given', () => {
    const o = buildE2bCreateOptions({}, 'k');
    expect(o.timeoutMs).toBe(5 * 60_000);
  });
});
