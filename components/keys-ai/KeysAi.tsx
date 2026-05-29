'use client';

// KeysAi — the AI-futuristic /settings/keys page. Restyles the shell
// (LiquidGlass, lq.* tokens, font-ui, the verified breathing rim, the
// aurora-rimmed security banner) but PRESERVES the key-management wiring
// byte-for-byte: GET / POST / DELETE against /api/connections/keys, same
// body shape, same headers, same query params. The banner copy comes from
// the single KEYS_SECURITY constant — every claim is literally true of
// the real storage model (AES-256-GCM at rest, scoped per user × provider,
// never echoed back, audit-logged). No fake activity graphs and no invented
// numbers — only fields the API actually returns.

import { useEffect, useState, type FormEvent } from 'react';
import { LiquidGlass } from '@/components/lq/LiquidGlass';
import {
  formatMaskedKey,
  KEYS_PROVIDERS,
  KEYS_SECURITY,
  PROVIDER_DESTINATION,
  keyStatusVm,
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

  const connectedCount = status
    ? KEYS_PROVIDERS.filter((p) => status[p.provider]?.connected).length
    : 0;
  const missingCount = KEYS_PROVIDERS.length - connectedCount;

  return (
    <section className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-7 px-2 py-12 font-ui text-lq-ink">
      {/* Header. */}
      <header className="flex flex-col gap-3">
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
          {loading
            ? 'loading…'
            : `${connectedCount} connected · ${missingCount} missing`}
        </p>
      </header>

      {/* Security banner — copy comes from the single KEYS_SECURITY constant. */}
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

      {/* Provider cards — one per REAL provider the API accepts. */}
      <div className="flex flex-col gap-4">
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
  const [key, setKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
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
      setShowForm(false);
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

  return (
    <LiquidGlass
      as="div"
      className={
        'flex flex-col gap-4 p-6 font-ui ' +
        (verified ? styles.verifiedRim : '')
      }
    >
      {/* Header row: provider + powers + status pill. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                verified ? 'bg-lq-aurora' : 'bg-lq-ink-dim'
              }`}
            />
            <span
              className={`font-code text-[10px] uppercase tracking-[0.3em] ${
                verified ? 'text-lq-aurora' : 'text-lq-ink-dim'
              }`}
            >
              {info.label}
            </span>
          </div>
          <p className="text-sm text-lq-ink-dim">{info.powers}</p>
        </div>
        <span
          className={`font-code text-[10px] uppercase tracking-[0.3em] ${
            verified ? 'text-lq-aurora' : 'text-lq-ink-faint'
          }`}
        >
          {vm.label}
        </span>
      </div>

      {/* Real destination URL — static; hover shifts to aurora. */}
      <p className="font-code text-[11px] text-lq-ink-faint transition-colors hover:text-lq-aurora">
        → {PROVIDER_DESTINATION[info.provider]}
      </p>

      {/* Key body — verified shows masked key + timestamp; missing shows a
          dashed empty placeholder. No invented activity numbers. */}
      {connected ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-lq-line bg-lq-elev-1 px-3 py-2">
          <p className="font-code text-[12px] text-lq-ink">{masked}</p>
          {status?.connected_at ? (
            <p className="font-code text-[10px] uppercase tracking-[0.2em] text-lq-ink-faint">
              connected · {new Date(status.connected_at).toLocaleString()}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex items-center justify-between rounded-[10px] border border-dashed border-lq-line bg-lq-elev-1/50 px-3 py-2">
          <p className="font-code text-[12px] text-lq-ink-faint">no key on file</p>
        </div>
      )}

      {/* Action row. */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {connected ? (
          <LiquidGlass
            as="button"
            type="button"
            onClick={() => setShowForm((s) => !s)}
            disabled={submitting || removeBusy}
            className="inline-flex items-center rounded-[14px] px-4 py-1.5 font-code text-[11px] uppercase tracking-[0.25em]"
          >
            {showForm ? 'cancel' : 'rotate key'}
          </LiquidGlass>
        ) : (
          <LiquidGlass
            as="button"
            type="button"
            onClick={() => setShowForm(true)}
            disabled={submitting || removeBusy}
            variant="aurora"
            className="inline-flex items-center rounded-[14px] px-5 py-2 text-sm font-semibold"
          >
            Connect →
          </LiquidGlass>
        )}
        {connected ? (
          <LiquidGlass
            as="button"
            type="button"
            onClick={onRemove}
            disabled={submitting || removeBusy}
            variant="rose"
            className="inline-flex items-center rounded-[14px] px-4 py-1.5 font-code text-[11px] uppercase tracking-[0.25em]"
          >
            {removeBusy ? 'removing…' : 'remove'}
          </LiquidGlass>
        ) : null}
      </div>

      {/* Paste form — same POST body as the forge KeysForm. */}
      {showForm ? (
        <form
          onSubmit={onSubmit}
          className="flex flex-col gap-3 border-t border-lq-line pt-4"
        >
          <label className="flex flex-col gap-1.5">
            <span className="font-code text-[10px] uppercase tracking-[0.3em] text-lq-ink-faint">
              {connected ? 'paste replacement key' : 'paste key'}
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
              {submitting ? 'verifying…' : connected ? 'replace' : 'save'}
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
