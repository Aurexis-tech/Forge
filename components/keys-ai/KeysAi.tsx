'use client';

// KeysAi — the AI-futuristic /settings/keys page. Two real sections:
//
//   API KEYS  — the BYOK cards (anthropic + e2b, the API's enforced enum).
//               REAL per-provider fields (connected, key_last4, connected_at)
//               only; no fabricated usage numbers. Test + Rotate primary
//               pair on connected cards; the "remove" rose link preserves
//               the DELETE wiring. ALL writes go through the same real
//               POST /api/connections/keys (the API validates against the
//               upstream provider before persisting — that IS the
//               verification path; both Test and Rotate map to it).
//
//   CONNECTIONS — the 3 OAuth platform integrations (GitHub / Vercel /
//                 Supabase). REAL status loaded server-side from the
//                 `connections` table via loadConnectionPublic, handed
//                 in as `oauthInitial`. SAME LiquidGlass card design as
//                 BYOK; OAuth affordance instead of a paste form:
//                 — Connected: shows real account_login + relative
//                   connected_at; no fields are invented; null fields are
//                   omitted with "—".
//                 — Empty: brief "what this unlocks" copy.
//                 — Connect / Manage link routes to /settings/connections,
//                   where the real OAuth handshake + disconnect logic lives.
//                 NO masked-key field on these — they're OAuth tokens, not
//                 API keys; the honest distinction stays visible.
//
// Honesty rails kept from the prior pass: every metric and label on
// this page is bound to a real field the API/connection record actually
// carries — no fabricated activity charts, no invented counters of any
// kind. The set of providers shown is also fixed in lib/keys-config.ts;
// nothing un-wired ever appears here.
//
// The header stat strip counts BOTH sides (BYOK + OAuth) so the
// Connected / Missing strip reflects the actual total of integrations
// on the page (today: 5).

import { useEffect, useState, type FormEvent } from 'react';
import { LiquidGlass } from '@/components/lq/LiquidGlass';
import {
  formatMaskedKey,
  formatRelativeTime,
  KEYS_PROVIDERS,
  KEYS_SECURITY,
  OAUTH_FLOW_HREF,
  OAUTH_PROVIDERS,
  PROVIDER_DESTINATION,
  PROVIDER_ICON,
  keyStatsVm,
  keyStatusVm,
  type OAuthConnectionSnapshot,
  type OAuthIconTint,
  type OAuthProviderInfo,
  type OAuthSnapshotByProvider,
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

const OAUTH_ICON_TINT_CLASS: Record<OAuthIconTint, string> = {
  // Brief: github = ink/neutral, vercel = ink/neutral, supabase = mint.
  ink: 'bg-lq-elev-1 border-lq-line text-lq-ink',
  mint: 'bg-lq-mint/15 border-lq-mint/40 text-lq-mint',
};

export function KeysAi({
  oauthInitial = {},
}: {
  /** Real OAuth connection status loaded server-side from the
   *  `connections` table. Keyed by provider; missing keys render as
   *  "Not connected" (honest, since the loader either found a row or
   *  it didn't). */
  oauthInitial?: OAuthSnapshotByProvider;
}) {
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

  const stats = keyStatsVm({ status, loading, oauth: oauthInitial });

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

      {/* === SECTION: API KEYS — the 2 REAL BYOK cards (anthropic + e2b). === */}
      <SectionHead
        eyebrow="API keys"
        title="API keys"
        sub="Bring your own — keys you paste here; we validate live, then store encrypted."
      />
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

      {/* === SECTION: CONNECTIONS — the 3 REAL OAuth cards. === */}
      <SectionHead
        eyebrow="Connections"
        title="Connections"
        sub="OAuth integrations — manage from /settings/connections."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {OAUTH_PROVIDERS.map((info) => (
          <OAuthCard
            key={info.provider}
            info={info}
            snapshot={oauthInitial[info.provider] ?? null}
          />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Section header — a small repeated eyebrow + h2 + sub above each card grid.
// ---------------------------------------------------------------------------

function SectionHead({
  eyebrow,
  title,
  sub,
}: {
  eyebrow: string;
  title: string;
  sub: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="font-code text-[10px] uppercase tracking-[0.35em] text-lq-aurora">
        {eyebrow}
      </span>
      <h2 className="font-ui text-xl font-bold tracking-tight text-lq-ink">
        {title}
      </h2>
      <p className="text-sm text-lq-ink-dim">{sub}</p>
    </div>
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
// ProviderCard — design-study card chrome over the REAL BYOK wiring.
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
  // Re-verify / rotate form state for CONNECTED cards (a tiny mode so the
  // form's labels reflect intent). Both POST to the same endpoint — the API
  // validates against upstream before persisting (that IS verification).
  // The EMPTY card no longer uses this: its box is an always-present paste
  // input submitted by "Connect →" (see the empty branch below).
  //   'test'   — connected; user wants to re-verify the stored key.
  //   'rotate' — connected; user wants to replace the stored key.
  type FormMode = 'test' | 'rotate';
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

      {/* Boxed key field — connected: a 2px aurora-left masked-key readout.
          Empty: a REAL dashed paste input (the box you click IS the field);
          "Connect →" below submits it. No invented numbers; only fields the
          API returns. */}
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
        // The box IS the input. Paste your key here and submit with the
        // "Connect →" button below (or Enter) — no hidden step. The dashed
        // treatment is kept, now on a REAL <input>: the field you click is
        // the field you type into. On focus it firms up to a solid aurora
        // border and left-aligns so a pasted key is readable.
        <form
          id={'connect-' + info.provider}
          onSubmit={onSubmit}
          className="flex flex-col gap-1.5"
        >
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            disabled={submitting}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label={'Paste your ' + info.label + ' API key'}
            placeholder={'paste your ' + info.provider + ' key'}
            className="w-full rounded-[10px] border border-dashed border-lq-line bg-lq-elev-1/50 px-4 py-3.5 text-center font-code text-sm tracking-[0.08em] text-lq-ink backdrop-blur-md transition placeholder:uppercase placeholder:tracking-[0.3em] placeholder:text-lq-ink-faint focus:border-solid focus:border-lq-aurora focus:text-left focus:tracking-[0.04em] focus:outline-none focus:shadow-[inset_0_0_44px_-14px_rgba(95,230,255,0.45)] focus:ring-2 focus:ring-[rgba(95,230,255,0.25)] disabled:opacity-60"
          />
          <span className="font-code text-[10px] text-lq-ink-faint">
            {info.hint}
          </span>
        </form>
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
          // Submits the empty-card paste form above via the HTML `form`
          // attribute — so the box and this button are one action: paste,
          // then Connect. (The box also submits on Enter.)
          <LiquidGlass
            as="button"
            type="submit"
            form={'connect-' + info.provider}
            disabled={submitting}
            variant="aurora"
            className="inline-flex items-center rounded-[14px] px-5 py-2 text-sm font-semibold"
          >
            {submitting ? 'verifying…' : 'Connect →'}
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
            className="rounded font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-faint transition-colors hover:text-lq-rose focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lq-rose/60 disabled:opacity-60"
          >
            {removeBusy ? 'removing…' : 'remove key'}
          </button>
        </div>
      ) : null}

      {/* Re-verify / rotate form for CONNECTED cards — same POST endpoint,
          same body. The label / submit copy reflect intent (Test re-checks
          the stored key; Rotate replaces it). Verification is real in both
          cases — the API performs the live upstream call before it persists.
          (The empty card's first-time paste lives in its own inline form
          above, submitted by "Connect →".) */}
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

// ---------------------------------------------------------------------------
// OAuthCard — same LiquidGlass shell as BYOK, OAuth affordance. NO
// masked-key field (these are OAuth tokens, not API keys; conflating the
// two would be dishonest). Body shows REAL fields from the server snapshot
// only — null fields are simply omitted. Connect / Manage routes to
// /settings/connections, where the real handshake + disconnect live.
// ---------------------------------------------------------------------------

function OAuthCard({
  info,
  snapshot,
}: {
  info: OAuthProviderInfo;
  snapshot: OAuthConnectionSnapshot | null;
}) {
  const connected = snapshot?.connected ?? false;
  const handle = snapshot?.account_login ?? null;
  const addedAgo = formatRelativeTime(snapshot?.connected_at ?? null);

  return (
    <LiquidGlass
      as="div"
      className={
        'flex flex-col gap-4 p-6 font-ui ' +
        (connected ? styles.verifiedRim : '')
      }
    >
      {/* TOP ROW — tinted icon chip + brand name + status pill. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className={
              'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border font-ui text-lg font-bold ' +
              OAUTH_ICON_TINT_CLASS[info.tint]
            }
          >
            {info.letter}
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="font-ui text-base font-bold tracking-tight text-lq-ink">
              {info.label}
            </span>
            <span className="font-code text-[10px] uppercase tracking-[0.25em] text-lq-ink-faint">
              oauth
            </span>
          </div>
        </div>
        <span
          className={
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-code text-[10px] uppercase tracking-[0.3em] ' +
            (connected
              ? 'border-lq-mint/40 bg-lq-mint/10 text-lq-mint'
              : 'border-lq-line bg-lq-elev-1 text-lq-ink-faint')
          }
        >
          {connected ? (
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
          {connected ? 'Connected' : 'Not connected'}
        </span>
      </div>

      {/* Body — REAL fields only:
          - Connected: account_login (if present) + relative connected_at
            (if present). Anything we don't actually have is omitted
            instead of "—" placeholders so we never claim what we don't
            know.
          - Empty: a brief "what this unlocks" line. */}
      {connected ? (
        <div className="flex flex-col gap-2 rounded-[10px] border border-lq-line border-l-2 border-l-lq-mint bg-lq-elev-1 px-4 py-3">
          {handle ? (
            <p className="font-code text-[13px] tracking-[0.02em] text-lq-ink">
              Connected as @{handle}
            </p>
          ) : (
            <p className="font-code text-[12px] uppercase tracking-[0.2em] text-lq-ink-faint">
              account on file
            </p>
          )}
          {addedAgo ? (
            <p className="font-code text-[10px] uppercase tracking-[0.2em] text-lq-ink-faint">
              connected {addedAgo}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex items-center justify-center rounded-[10px] border border-dashed border-lq-line bg-lq-elev-1/50 px-4 py-5">
          <p className="font-code text-[11px] uppercase tracking-[0.25em] text-lq-ink-faint">
            unlocks {info.unlocks}
          </p>
        </div>
      )}

      {/* Affordance row — a single LiquidGlass anchor to the REAL
          /settings/connections flow. We do NOT run the OAuth dance
          here; the unlink control also lives on that page, not this
          one. */}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-lq-line pt-4">
        <LiquidGlass
          as="a"
          href={OAUTH_FLOW_HREF}
          variant={connected ? 'default' : 'aurora'}
          className="inline-flex items-center rounded-[14px] px-5 py-2 text-sm font-semibold"
        >
          {connected ? 'Manage →' : 'Connect →'}
        </LiquidGlass>
      </div>
    </LiquidGlass>
  );
}
