// Hermetic tests for the AuthorizationGate migration. The "human holds
// the keys" trust moment is centralised in ONE component; restyling it
// covers all 12 calling flows (push / deploy / runtime / provision /
// infra apply / infra confirm). The honesty rules — render only the
// REAL disclosure the flow passes, no fabricated capabilities / spend /
// threat-level fields, preserve every real callback — are encoded as
// assertions over the gate's source + simulated render via a small DOM-
// free harness that exercises its pure behaviour.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8');
const GATE = read('components/gate/AuthorizationGate.tsx');
const GATE_CSS = read('components/gate/gate.module.css');

// ===========================================================================
// 1. AuthorizationGate is migrated to the AI primitives (the only restyle)
// ===========================================================================
describe('AuthorizationGate — AI-futuristic shell', () => {
  it('is a client component on LiquidGlass with the rose variant + lq tokens + font-ui', () => {
    expect(GATE).toMatch(/^'use client'/m);
    expect(GATE).toMatch(/from '@\/components\/lq\/LiquidGlass'/);
    expect(GATE).toMatch(/variant="rose"/);
    expect(GATE).toMatch(/font-ui/);
    expect(GATE).toMatch(/text-lq-(ink|rose|ink-dim|ink-faint)/);
  });

  it('drops every forge primitive from this component (no GlassPanel, no forge-* tokens)', () => {
    expect(GATE).not.toMatch(/from '@\/components\/GlassPanel'/);
    expect(GATE).not.toMatch(/<GlassPanel/);
    expect(GATE).not.toMatch(/text-forge-/);
    expect(GATE).not.toMatch(/border-forge-/);
    expect(GATE).not.toMatch(/shadow-amber/);
  });

  it('the heading is font-ui — the rest of the system stays consistent', () => {
    expect(GATE).toMatch(/<h3 className="font-ui/);
  });
});

// ===========================================================================
// 2. Public API + the prop contract is unchanged (12 callers depend on it)
// ===========================================================================
describe('AuthorizationGateProps — surface area preserved verbatim', () => {
  it('exports AuthorizationGateProps with the same prop names + types', () => {
    // Field names every caller passes (or might pass). Order doesn't matter;
    // presence does — if we drop one, a caller silently loses functionality.
    for (const prop of [
      'title:',
      'summary:',
      'helper?:',
      'confirmLabel:',
      'cancelLabel?:',
      'requireText?:',
      'onApprove:',
      'onCancel?:',
      'error?:',
    ]) {
      expect(GATE, prop).toMatch(new RegExp(prop.replace(/\?/g, '\\?')));
    }
  });

  it('summary still accepts string OR { label, value } rows (existing callers use both)', () => {
    expect(GATE).toMatch(
      /summary:\s*ReadonlyArray<string \| \{ label: string; value: string \}>/,
    );
  });

  it('exports the AuthorizationGate function component', () => {
    expect(GATE).toMatch(/export function AuthorizationGate\(/);
  });
});

// ===========================================================================
// 3. requireText validation preserved EXACTLY (typed must match before approve)
// ===========================================================================
describe('requireText validation — same gate, same predicate', () => {
  it('approve stays disabled until typed.trim() === requireText (the existing predicate)', () => {
    expect(GATE).toMatch(
      /requireSatisfied\s*=\s*!requireText \|\| typed\.trim\(\) === requireText/,
    );
    // The disabled flag on approve composes busy + requireSatisfied.
    expect(GATE).toMatch(/disabled=\{busy \|\| !requireSatisfied\}/);
    // The early-return inside approve() also gates on requireSatisfied.
    expect(GATE).toMatch(/if \(busy \|\| !requireSatisfied\) return/);
  });

  it('the typed-confirmation input renders ONLY when requireText is set', () => {
    expect(GATE).toMatch(/\{requireText \?[\s\S]+?<input\b/);
    // The match shape "type X to confirm" stays — the field labels itself
    // with the literal string the caller demands.
    expect(GATE).toMatch(/type <span[^>]*>\{requireText\}<\/span> to confirm/);
  });
});

// ===========================================================================
// 4. onApprove + onCancel callbacks preserved verbatim
// ===========================================================================
describe('callbacks — onApprove + onCancel still fire the caller-provided functions', () => {
  it('approve() awaits onApprove() (the real action POST runs unchanged)', () => {
    expect(GATE).toMatch(/await onApprove\(\)/);
  });

  it('cancel fires onCancel() (the parent decides what cancel means)', () => {
    expect(GATE).toMatch(/onClick=\{\(\) => !busy && onCancel\(\)\}/);
  });

  it('busy state still flips during approve() (button shows "Working…")', () => {
    expect(GATE).toMatch(/setBusy\(true\)/);
    expect(GATE).toMatch(/setBusy\(false\)/);
    expect(GATE).toMatch(/busy \? 'Working…'/);
  });
});

// ===========================================================================
// 5. Disclosure honesty — render ONLY what the flow provides
// ===========================================================================
describe('disclosure honesty — never invents capabilities / spend / threat-level', () => {
  it('renders the summary[] verbatim, supporting both string + {label,value} shapes', () => {
    // The whole point of the gate's generic design — what the flow passes
    // is what the user sees.
    expect(GATE).toMatch(/summary\.map\(\(row, i\) =>/);
    // Both branches render — string and { label, value }.
    expect(GATE).toMatch(/typeof row === 'string'/);
    expect(GATE).toMatch(/\{row\.label\}/);
    expect(GATE).toMatch(/\{row\.value\}/);
  });

  it('does NOT invent capabilities / permissions / spend-impact / threat-level fields', () => {
    // The study showed mock "capabilities" + "+$X/mo" + "blast radius"
    // fields that no caller provides. We render NONE of those.
    expect(GATE).not.toMatch(/capabilit/i);
    expect(GATE).not.toMatch(/permission/i);
    expect(GATE).not.toMatch(/spend\s*impact/i);
    expect(GATE).not.toMatch(/\/mo/);
    expect(GATE).not.toMatch(/blast[- ]radius/i);
    expect(GATE).not.toMatch(/threat[- ]level/i);
  });

  it('renders helper text + error text only when the caller provides them', () => {
    expect(GATE).toMatch(/\{helper \?/);
    expect(GATE).toMatch(/\{error \?/);
  });
});

// ===========================================================================
// 6. Generic across every flow shape (parameterised fixture check)
// ===========================================================================
describe('all 12 callers still satisfy the gate contract (no caller broken)', () => {
  // For each caller, assert it still imports AuthorizationGate, passes a
  // confirmLabel + onApprove, and posts to its real endpoint.
  // Each caller asserts: still imports + uses the gate, contains its
  // confirmLabel literal (which may be inside a ternary expression — so
  // we match the literal string anywhere in the file rather than
  // requiring `confirmLabel="..."`), posts to its real endpoint, and
  // still triggers router.refresh() on success. `sendsAuthorized` is
  // optional because ApplyInfraPanel posts an empty body — the real
  // contract is "POST to the endpoint", not the body shape.
  const callers: ReadonlyArray<{
    file: string;
    confirmLabel: string;
    endpoint: RegExp;
    sendsAuthorized?: boolean;
  }> = [
    {
      file: 'components/github/GitHubPushPanel.tsx',
      confirmLabel: 'Create repo & push',
      endpoint: /\/build\/push/,
      sendsAuthorized: true,
    },
    {
      file: 'components/system/SystemGitHubPushPanel.tsx',
      confirmLabel: 'Create repo & push system',
      endpoint: /\/system\/build\/push/,
      sendsAuthorized: true,
    },
    {
      file: 'components/software/SoftwareGitHubPushPanel.tsx',
      confirmLabel: 'Create repo & push app',
      endpoint: /\/software\/build\/push/,
      sendsAuthorized: true,
    },
    {
      file: 'components/vercel/DeployFlow.tsx',
      confirmLabel: 'Deploy to Vercel',
      endpoint: /\/build\/deploy/,
      sendsAuthorized: true,
    },
    {
      file: 'components/system/SystemDeployFlow.tsx',
      confirmLabel: 'Deploy system',
      endpoint: /\/system\/build\/deploy/,
      sendsAuthorized: true,
    },
    {
      file: 'components/software/SoftwareDeployFlow.tsx',
      confirmLabel: 'Deploy app',
      endpoint: /\/software\/build\/deploy/,
      sendsAuthorized: true,
    },
    {
      file: 'components/runtime/ActivateRuntimeFlow.tsx',
      confirmLabel: 'Activate runtime',
      endpoint: /\/runtime\/activate/,
      sendsAuthorized: true,
    },
    {
      file: 'components/system/SystemActivateRuntimeFlow.tsx',
      confirmLabel: 'Activate system runtime',
      endpoint: /\/system\/runtime\/activate/,
      sendsAuthorized: true,
    },
    {
      file: 'components/software/SoftwareActivateRuntimeFlow.tsx',
      confirmLabel: 'Mark app live',
      endpoint: /\/software\/runtime\/activate/,
      sendsAuthorized: true,
    },
    {
      file: 'components/software/ProvisionDbFlow.tsx',
      // confirmLabel is a runtime ternary: 'Provision database' / 'Apply schema'.
      confirmLabel: 'Provision database',
      endpoint: /\/software\/db\/provision/,
      sendsAuthorized: true,
    },
    {
      file: 'components/infra/ApplyInfraPanel.tsx',
      confirmLabel: 'Apply now',
      endpoint: /\/infra\/build\/apply/,
      // Posts with no body — the endpoint itself is the gated action.
      sendsAuthorized: false,
    },
    {
      file: 'components/infra/InfraConfirmPlanFlow.tsx',
      confirmLabel: 'Confirm plan',
      endpoint: /\/infra\/build\/confirm-plan/,
      // Posts a typed-phrase confirmation (its own ceremony); not
      // `authorized: true`.
      sendsAuthorized: false,
    },
  ];

  it.each(callers)(
    '$file still uses the gate + posts to the real endpoint',
    ({ file, confirmLabel, endpoint, sendsAuthorized }) => {
      const src = read(file);
      expect(src, file).toMatch(/from '@\/components\/gate\/AuthorizationGate'/);
      expect(src, file).toMatch(/<AuthorizationGate/);
      // confirmLabel literal must appear somewhere (tolerant of ternaries).
      expect(src, file).toContain(confirmLabel);
      expect(src, file).toMatch(endpoint);
      if (sendsAuthorized) {
        expect(src, file).toMatch(/authorized:\s*true/);
      }
      // Post-approve refresh preserved.
      expect(src, file).toMatch(/router\.refresh\(\)/);
    },
  );

  it('NO current caller sets requireText (the prop stays for future flows)', () => {
    for (const { file } of callers) {
      expect(read(file), file).not.toMatch(/requireText=/);
    }
  });
});

// ===========================================================================
// 7. Pure-behaviour harness — exercise the gate's logic without a DOM
// ===========================================================================
// The pure piece of the gate is the `requireSatisfied` predicate +
// `approve` early-return. We re-derive both here as the smallest behaviour
// check that doesn't require jsdom (the project is node-only).
describe('pure behaviour — requireText predicate works for every fixture shape', () => {
  // Mirrors the gate's internal predicate exactly.
  const isSatisfied = (requireText: string | undefined, typed: string) =>
    !requireText || typed.trim() === requireText;

  it('no requireText → always satisfied (every current caller)', () => {
    expect(isSatisfied(undefined, '')).toBe(true);
    expect(isSatisfied(undefined, 'anything')).toBe(true);
  });

  it('with requireText → satisfied only on exact match (whitespace-trimmed)', () => {
    expect(isSatisfied('APPLY', '')).toBe(false);
    expect(isSatisfied('APPLY', 'appl')).toBe(false);
    expect(isSatisfied('APPLY', 'apply')).toBe(false); // case matters
    expect(isSatisfied('APPLY', 'APPLY')).toBe(true);
    expect(isSatisfied('APPLY', '  APPLY  ')).toBe(true); // trim-tolerant
  });
});

// ===========================================================================
// 8. Infinite-animation budget — gates don't throb
// ===========================================================================
describe('infinite-animation budget — the gate doesn\'t throb', () => {
  const countInfinite = (path: string) =>
    (read(path)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .match(/animation[^;]*infinite/g) ?? []).length;

  it('the gate module has ZERO infinite loops (no anxious looping on a weighty action)', () => {
    expect(countInfinite('components/gate/gate.module.css')).toBe(0);
  });

  it('globals.css still ≤4 infinite loops (no gate keyframes leaked)', () => {
    expect(countInfinite('app/globals.css')).toBeLessThanOrEqual(4);
    const css = read('app/globals.css');
    expect(css).not.toMatch(/gateMountFade/);
  });

  it('the mount fade is one-shot (fill mode both, NOT infinite)', () => {
    expect(GATE_CSS).toMatch(/animation:\s*gateMountFade\s+\d+ms[^;]*both/);
    // Strip comments before checking — the comment header naturally
    // mentions "infinite" in prose; what matters is no live rule does.
    const stripped = GATE_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(stripped).not.toMatch(/infinite/);
  });
});
