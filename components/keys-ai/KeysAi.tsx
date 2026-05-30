'use client';

// KeysAi — the AI-futuristic /settings/keys page. Chrome upgraded to the
// design-study card + header look while keeping every honesty correction:
//   - REAL provider set (anthropic + e2b only — the API's enforced enum).
//   - REAL per-provider fields (connected, key_last4, connected_at) ONLY.
//     None of the design-study's invented usage numbers are surfaced —
//     none of those signals exist on the connection record today.
//   - REAL security banner ("encrypted at rest", NOT "zero-knowledge").
//     The false-claim test in keys-ai.test.ts stays in force.
//   - REAL wiring: GET / POST / DELETE against /api/connections/keys with
//     the same body shapes the forge KeysForm used. Preserved verbatim.
//
// Card chrome:
//   - Header is two-part: left = eyebrow + h1 + sub; right = a LiquidGlass
//     stat strip with three cells (Connected / Missing / Errors) bound to
//     the pure keyStatsVm helper.
//   - Provider cards: tinted single-letter icon chip (anthropic = amber A,
//     e2b = violet E), a richer status pill ("Verified" with a pulsing
//     aurora dot on connected, "Not connected" faint on empty), a boxed
//     masked-key field with a 2px aurora left border (or a dashed
//     "paste to connect" treatment when empty), the real destination URL
//     hover-aurora, the honest one-line description, an optional "added
//     <X ago>" line driven by the real connected_at, and a Test + Rotate
//     primary action pair on connected cards or a "Connect →" CTA on
//     empty. A small rose "remove" secondary preserves the DELETE wiring
//     per the prompt's "preserve set/verify/rotate/delete" constraint.
//
// HONEST "Test" wiring: the API has no separate verify endpoint, but the
// POST that Rotate uses validates the pasted key with a tiny live call to
// the upstream provider before persisting (that IS the verification path).
// So "Test" opens the same paste form as Rotate, labeled "paste your
// current key to verify"; submitting POSTs through the same endpoint and
// the API validates against the provider. Both buttons map to the SAME
// real action; the label reflects the user's intent (re-check vs replace),
// and the validation that runs is real upstream verification — nothing
// inert.

import { useEffect, useState, type FormEvent } from 'react';
import { LiquidGlass } from '@/components/lq/LiquidGlass';
import {
  formatMaskedKey,
  formatRelativeTime,
  KEYS_PROVIDERS,
  KEYS_SECURITY,
  PROVIDER_DESTINATION,
  PROVIDER_ICON,
  keyStatsVm,
  keyStatusVm,
  type ProviderIconTint,
  type ProviderInfo,
} from '@/lib/keys-config';
import type { ByokProvider } from '@/lib/types';
import styles from './keys.module.css';

interface ProviderStatus {
  connected: boolean;
  key_last4: string | null;
  connected_at: string | null;
}
type StatusResponse = Record<ByokProvider, ProviderStatus>;

const ICON_TINT_CLASS: Record<ProviderIconTint, string> = {
  amber: 'bg-lq-amber/15 border-lq-amber/40 text-lq-amber',
  violet: 'bg-lq-violet/15 border-lq-violet/40 text-lq-violet',
};

export function KeysAi() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      const res = await fetch('/api/connections/keys', { method: 'GET' });
      const body = (await res.json()) as StatusResponse | { error?: string };
      if (!res.ok) {
        throw new Error((body as { error?: string }).error ?? 'load failed');
      }
      setStatus(body as StatusResponse);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load failed');
    } finally {
      setLoading(false);
    }
  }

  const stats = keyStatsVm({ status, loading });

  return (
    <section className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-2 py-12 font-ui text-lq-ink">
      {/* Header — two-part: left (eyebrow + h1 + sub) / right (stat strip). */}
      <header className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <span className="font-code text-[11px] uppercase tracking-[0.35em] text-lq-aurora">
              {KEYS_SECURITY.eyebrow}
            </span>
            <span
              aria-hidden
              className="h-px w-12 bg-gradient-to-r from-lq-aurora to-transparent"
            />
          </div>
          <h1 className="font-ui text-4xl font-extrabold tracking-[-0.02em] text-lq-ink sm:text-5xl">
            Keys
          </h1>
          <p className="font-code text-[12px] text-lq-ink-faint">
            {stats.loading
              ? 'loading…'
              : stats.connected + ' connected · ' + stats.missing + ' missing'}
          </p>
        </div>

        <LiquidGlass
          as="div"
          className="flex items-stretch divide-x divide-lq-line rounded-[14px] p-0 font-ui"
        >
          <StatCell label="Connected" value={stats.connected} tone="aurora" />
          <StatCell label="Missing" value={stats.missing} tone="ink-faint" />
          <StatCell label="Errors" value={stats.errors} tone="mint" />
        </LiquidGlass>
      </header>

      {/* Security banner — UNCHANGED. Copy comes from KEYS_SECURITY. */}
      <LiquidGlass
        as="div"
        className="flex flex-col gap-3 border-l-2 border-l-lq-aurora p-6 font-ui"
      >
        <span className="font-code text-[10px] uppercase tracking-[0.4em] text-lq-aurora">
          Security
        </span>
        <h2 className="font-ui text-xl font-bold tracking-tight text-lq-ink">
          {KEYS_SECURITY.headline}
        </h2>
        <p className="text-sm leading-relaxed text-lq-ink-dim">
          {KEYS_SECURITY.mechanism}
        </p>
        <ul className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1.5 font-code text-[11px] text-lq-ink-faint">
          {KEYS_SECURITY.claims.map((c) => (
            <li key={c} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block h-1 w-1 rounded-full bg-lq-aurora"
              />
              <span>{c}</span>
            </li>
          ))}
        </ul>
      </LiquidGlass>

      {error ? (
        <p
          role="alert"
          className="rounded-[14px] border border-lq-rose/40 bg-lq-rose/10 px-3 py-2 text-sm text-lq-rose"
        >
          {error}
        </p>
      ) : null}

      {/* Provider cards — 2-col grid for the two REAL providers. */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {KEYS_PROVIDERS.map((info) => (
          <ProviderCard
            key={info.provider}
            info={info}
            status={status?.[info.provider] ?? null}
            loading={loading}
            onChanged={refresh}
          />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Header stat cell — three of these inside the LiquidGlass strip.
// ---------------------------------------------------------------------------

function StatCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'aurora' | 'mint' | 'ink-faint';
}) {
  const toneTextClass =
    tone === 'aurora'
      ? 'text-lq-aurora'
      : tone === 'mint'
        ? 'text-lq-mint'
        : 'text-lq-ink-faint';
  return (
    <div className="flex flex-col items-center justify-center gap-1 px-5 py-3 sm:px-7 sm:py-4">
      <span className={'font-ui text-2xl font-bold tabular-nums ' + toneTextClass}>
        {value}
      </span>
      <span className="font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-faint">
        {label}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProviderCard — design-study card chrome over the REAL wiring.
// ---------------------------------------------------------------------------

function ProviderCard({
  info,
  status,
  loading,
  onChanged,
}: {
  info: ProviderInfo;
  status: ProviderStatus | null;
  loading: boolean;
  onChanged: () => void | Promise<void>;
}) {
  // Paste-form open state + a tiny mode so the form's labels reflect the
  // user's intent. ALL modes POST to the same endpoint — the API validates
  // against upstream before persisting (that IS the verification path).
  //   'connect' — empty card; the only entry point.
  //   'test'    — connected; user wants to re-verify the stored key.
  //   'rotate'  — connected; user wants to replace the stored key.
  type FormMode = 'connect' | 'test' | 'rotate';
  const [formMode, setFormMode] = useState<FormMode | null>(null);
  const [key, setKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);

  const connected = status?.connected ?? false;
  const vm = keyStatusVm({ connected, loading });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setCardError(null);
    const trimmed = key.trim();
    if (trimmed.length < 8) {
      setCardError('Paste a real key.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/connections/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: info.provider, key: trimmed }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        key_last4?: string;
      };
      if (!res.ok) {
        throw new Error(body.error ?? 'request failed (' + res.status + ')');
      }
      setKey('');
      setFormMode(null);
      await onChanged();
    } catch (err) {
      setCardError(err instanceof Error ? err.message : 'connect failed');
    } finally {
      setSubmitting(false);
    }
  }

  async function onRemove() {
    if (!confirm('Remove your ' + info.label + ' key from the Forge?')) return;
    setCardError(null);
    setRemoveBusy(true);
    try {
      const res = await fetch(
        '/api/connections/keys?provider=' + info.provider,
        { method: 'DELETE' },
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'remove failed');
      await onChanged();
    } catch (err) {
      setCardError(err instanceof Error ? err.message : 'remove failed');
    } finally {
      setRemoveBusy(false);
    }
  }

  const verified = vm.status === 'verified';
  const masked = formatMaskedKey(status?.key_last4 ?? null);
  const icon = PROVIDER_ICON[info.provider];
  const addedAgo = connected ? formatRelativeTime(status?.connected_at ?? null) : '';

  return (
    <LiquidGlass
      as="div"
      className={
        'flex flex-col gap-4 p-6 font-ui ' +
        (verified ? styles.verifiedRim : '')
      }
    >
      {/* TOP ROW — tinted icon chip + brand name + status pill. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className={
              'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border font-ui text-lg font-bold ' +
              ICON_TINT_CLASS[icon.tint]
            }
          >
            {icon.letter}
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="font-ui text-base font-bold tracking-tight text-lq-ink">
              {info.label}
            </span>
            <span className="font-code text-[10px] uppercase tracking-[0.25em] text-lq-ink-faint">
              {info.provider}
            </span>
          </div>
        </div>
        <span
          className={
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-code text-[10px] uppercase tracking-[0.3em] ' +
            (verified
              ? 'border-lq-mint/40 bg-lq-mint/10 text-lq-mint'
              : 'border-lq-line bg-lq-elev-1 text-lq-ink-faint')
          }
        >
          {verified ? (
            <span
              aria-hidden
              className={
                'inline-block h-1.5 w-1.5 rounded-full bg-lq-mint ' +
                styles.statusPulseDot
              }
            />
          ) : (
            <span
              aria-hidden
              className="inline-block h-1.5 w-1.5 rounded-full bg-lq-ink-faint"
            />
          )}
          {vm.label}
        </span>
      </div>

      {/* Honest one-line description (the "powers" sentence). */}
      <p className="text-sm leading-relaxed text-lq-ink-dim">{info.powers}</p>

      {/* Boxed masked-key field — 2px aurora left border when connected;
          dashed "paste to connect" treatment when empty. No invented
          numbers; only fields the API returns. */}
      {connected ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-lq-line border-l-2 border-l-lq-aurora bg-lq-elev-1 px-4 py-3">
          <p className="font-code text-[13px] tracking-[0.05em] text-lq-ink">
            {masked}
          </p>
          {addedAgo ? (
            <p className="font-code text-[10px] uppercase tracking-[0.2em] text-lq-ink-faint">
              added {addedAgo}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex items-center justify-center rounded-[10px] border border-dashed border-lq-line bg-lq-elev-1/50 px-4 py-5">
          <p className="font-code text-[11px] uppercase tracking-[0.3em] text-lq-ink-faint">
            paste to connect
          </p>
        </div>
      )}

      {/* Real destination URL — static; hover shifts to aurora. */}
      <p className="font-code text-[11px] text-lq-ink-faint transition-colors hover:text-lq-aurora">
        → {PROVIDER_DESTINATION[info.provider]}
      </p>

      {/* Primary action row — matches the design study:
            connected → Test + Rotate (both open the paste form; submit
                        POSTs to /api/connections/keys, where the API
                        validates against the upstream provider before
                        persisting — same wiring for both labels).
            empty     → Connect →
          A small rose "remove" secondary preserves the DELETE wiring
          per the prompt's "preserve set/verify/rotate/delete" constraint
          without crowding the primary pair. */}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-lq-line pt-4">
        {connected ? (
          <>
            <LiquidGlass
              as="button"
              type="button"
              onClick={() =>
                setFormMode((m) => (m === 'test' ? null : 'test'))
              }
              disabled={submitting || removeBusy}
              className="inline-flex items-center rounded-[14px] px-4 py-1.5 font-code text-[11px] uppercase tracking-[0.25em]"
            >
              {formMode === 'test' ? 'cancel' : 'Test'}
            </LiquidGlass>
            <LiquidGlass
              as="button"
              type="button"
              onClick={() =>
                setFormMode((m) => (m === 'rotate' ? null : 'rotate'))
              }
              disabled={submitting || removeBusy}
              variant="aurora"
              className="inline-flex items-center rounded-[14px] px-4 py-1.5 font-code text-[11px] uppercase tracking-[0.25em]"
            >
              {formMode === 'rotate' ? 'cancel' : 'Rotate'}
            </LiquidGlass>
          </>
        ) : (
          <LiquidGlass
            as="button"
            type="button"
            onClick={() => setFormMode('connect')}
            disabled={submitting || removeBusy}
            variant="aurora"
            className="inline-flex items-center rounded-[14px] px-5 py-2 text-sm font-semibold"
          >
            Connect →
          </LiquidGlass>
        )}
      </div>

      {/* Secondary destructive — preserves DELETE wiring (rose link, not
          a primary button, so the Test/Rotate pair stays the visual lead
          per the mockup). Only present on connected cards. */}
      {connected ? (
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={onRemove}
            disabled={submitting || removeBusy}
            className="font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-faint transition-colors hover:text-lq-rose disabled:opacity-60"
          >
            {removeBusy ? 'removing…' : 'remove key'}
          </button>
        </div>
      ) : null}

      {/* Paste form — same POST endpoint, same body for every mode. The
          label / placeholder / submit copy reflect the user's intent
          (Test re-checks the current key; Rotate replaces with a new
          one; Connect adds the first key). Verification is real in
          every case — the API performs the live upstream call before it
          persists. */}
      {formMode ? (
        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-3 border-t border-lq-line pt-4"
        >
          <label className="flex flex-col gap-1.5">
            <span className="font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-faint">
              {formMode === 'test'
                ? 'paste your current key to verify'
                : formMode === 'rotate'
                  ? 'paste a new key'
                  : 'paste key'}
            </span>
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              disabled={submitting}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder={'paste your ' + info.provider + ' key'}
              className="w-full rounded-[10px] border border-lq-line bg-white/[0.04] px-3 py-2 font-code text-sm text-lq-ink backdrop-blur-md transition placeholder:text-lq-ink-faint focus:border-lq-aurora focus:outline-none focus:shadow-[inset_0_0_44px_-14px_rgba(95,230,255,0.45)] focus:ring-2 focus:ring-[rgba(95,230,255,0.25)] disabled:opacity-60"
            />
            <span className="font-code text-[10px] text-lq-ink-faint">
              {info.hint}
            </span>
          </label>

          <div className="flex items-center justify-end">
            <LiquidGlass
              as="button"
              type="submit"
              disabled={submitting}
              variant="aurora"
              className="inline-flex items-center rounded-[14px] px-5 py-2 text-sm font-semibold"
            >
              {submitting
                ? 'verifying…'
                : formMode === 'test'
                  ? 'verify'
                  : formMode === 'rotate'
                    ? 'replace'
                    : 'save'}
            </LiquidGlass>
          </div>
        </form>
      ) : null}

      {cardError ? (
        <p
          role="alert"
          className="rounded-[10px] border border-lq-rose/40 bg-lq-rose/10 px-3 py-2 text-sm text-lq-rose"
        >
          {cardError}
        </p>
      ) : null}
    </LiquidGlass>
  );
}
