// UI static-shape test for ToolProviderKeysSection.
//
// The project ships without a DOM test env (vitest + node), so — same
// pattern as the capability/audit sweeps — we scan the component
// source for the security- + UX-critical shapes the prompt requires:
//   - the key input is type="password" and NOT pre-filled (bound to a
//     state that starts ''; never seeded from server status),
//   - the section is registry-driven (renders from the
//     /api/connections/tool-provider status, one panel per provider),
//   - connected / not-connected states + a verify-failed inline branch,
//   - a disconnect control with a confirm,
//   - the key is cleared on submit (never held in client state after).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = readFileSync(
  path.resolve(
    __dirname,
    '..',
    '..',
    'components',
    'connections',
    'ToolProviderKeysSection.tsx',
  ),
  'utf8',
);

describe('ToolProviderKeysSection — security-critical shape', () => {
  it('the key input is type="password"', () => {
    expect(SRC).toMatch(/type="password"/);
  });

  it('the key input is NOT pre-filled — bound to a state initialised empty', () => {
    // value={key} where key = useState('') — never seeded from status.
    expect(SRC).toContain("const [key, setKey] = useState('')");
    expect(SRC).toContain('value={key}');
    // No binding of the input value to any server-provided field.
    expect(SRC).not.toMatch(/value=\{status\.(key|token)/);
  });

  it('clears the key on submit (re-render must not carry the secret)', () => {
    expect(SRC).toContain("setKey('')");
  });

  it('autocomplete is off on the key input', () => {
    expect(SRC).toContain('autoComplete="off"');
  });
});

describe('ToolProviderKeysSection — registry-driven + states', () => {
  it('renders from the tool-provider status endpoint (not a hardcoded list)', () => {
    expect(SRC).toContain("fetch('/api/connections/tool-provider'");
    // One panel per provider returned by the endpoint.
    expect(SRC).toMatch(/providers\.map\(/);
  });

  it('POSTs the key to the per-provider save route (provider in the path, key in the body)', () => {
    expect(SRC).toContain("'/api/connections/tool-provider/' + encodeURIComponent(status.provider)");
    expect(SRC).toContain("body: JSON.stringify({ key: trimmed })");
  });

  it('handles the 422 verify_failed branch inline (no persist)', () => {
    expect(SRC).toContain('verify_failed');
    expect(SRC).toContain('verify failed');
  });

  it('renders connected + not-connected states', () => {
    expect(SRC).toContain('connected');
    expect(SRC).toContain('not connected');
  });

  it('has a disconnect control guarded by a confirm', () => {
    expect(SRC).toMatch(/confirm\(/);
    expect(SRC).toContain('/disconnect');
  });

  it('is visually distinct from platform connections (its own "agent tool keys" heading)', () => {
    expect(SRC.toLowerCase()).toContain('agent tool keys');
  });
});
