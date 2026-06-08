'use client';

// Sign-in. PRIMARY path is a 6-digit EMAIL CODE, not a clickable magic link.
//
// Why: corporate / Outlook "SafeLinks" and other email security scanners
// PREFETCH the magic-link URL, which hits Supabase's one-time verify endpoint
// and CONSUMES the token before the human ever clicks — so the real click
// lands on `otp_expired`. A 6-digit code has no URL to prefetch, so it's
// immune. The same email still carries a magic link (emailRedirectTo) as a
// fallback for inboxes that don't scan. On a link failure the callback bounces
// back here with ?auth_error=... and we steer the user straight to the code.
//
// NOTE (Supabase dashboard): for the code to appear in the email, the
// "Magic Link" email template must include the {{ .Token }} variable. The
// Site URL + Redirect URLs must also list https://aurexis.app for the magic
// link fallback to return to prod instead of localhost.

import { Suspense, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';
import { GlassPanel } from '@/components/GlassPanel';

function makeClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

function SignInForm() {
  const params = useSearchParams();
  const next = params.get('next') ?? '/projects';
  const authError = params.get('auth_error');

  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(
    authError
      ? 'That sign-in link didn’t work — it may have expired or been opened by your email provider’s link scanner. Enter your email to get a fresh 6-digit code.'
      : null,
  );

  function callbackUrl(): string {
    return (
      (typeof window !== 'undefined' ? window.location.origin : '') +
      '/auth/callback?next=' +
      encodeURIComponent(next)
    );
  }

  async function sendCode(targetEmail: string) {
    const supabase = makeClient();
    const { error: signErr } = await supabase.auth.signInWithOtp({
      email: targetEmail,
      options: { emailRedirectTo: callbackUrl() },
    });
    if (signErr) throw signErr;
  }

  async function onSendCode(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const trimmed = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError('Enter a valid email address.');
      return;
    }
    setSending(true);
    try {
      await sendCode(trimmed);
      setEmail(trimmed);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setSending(false);
    }
  }

  async function onResend() {
    setError(null);
    setNotice(null);
    setSending(true);
    try {
      await sendCode(email.trim().toLowerCase());
      setNotice('A fresh code is on its way.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resend.');
    } finally {
      setSending(false);
    }
  }

  async function onVerify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const token = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(token)) {
      setError('Enter the 6-digit code from your email.');
      return;
    }
    setVerifying(true);
    try {
      const supabase = makeClient();
      const { error: verifyErr } = await supabase.auth.verifyOtp({
        email: email.trim().toLowerCase(),
        token,
        type: 'email',
      });
      if (verifyErr) throw verifyErr;
      // Full navigation so the server picks up the freshly-set session cookie.
      window.location.assign(next);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'That code didn’t work. Request a new one.',
      );
      setVerifying(false);
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center py-12">
      <GlassPanel className="w-full max-w-md">
        <div className="flex flex-col gap-5">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
              sign in
            </p>
            <h1 className="mt-2 text-2xl font-medium text-forge-text">
              Enter the Forge
            </h1>
            <p className="mt-2 text-sm text-forge-dim">
              {sent
                ? 'Enter the 6-digit code from your email — no password.'
                : 'We’ll email you a 6-digit sign-in code. No password.'}
            </p>
          </div>

          {notice ? (
            <div className="rounded-lg border border-forge-amber/40 bg-forge-amber/[0.06] p-3">
              <p className="text-sm text-forge-text/90">{notice}</p>
            </div>
          ) : null}

          {sent ? (
            <form onSubmit={onVerify} className="flex flex-col gap-3">
              <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/[0.06] p-3">
                <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-emerald-300">
                  check your inbox
                </p>
                <p className="mt-1 text-sm text-forge-text/90">
                  We sent a code (and a backup magic link) to{' '}
                  <span className="font-mono">{email}</span>.
                </p>
              </div>

              <label className="flex flex-col gap-1.5">
                <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
                  6-digit code
                </span>
                <input
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="\d*"
                  maxLength={6}
                  value={code}
                  onChange={(e) =>
                    setCode(e.target.value.replace(/\D/g, '').slice(0, 6))
                  }
                  disabled={verifying}
                  required
                  autoFocus
                  className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-center font-mono text-lg tracking-[0.5em] text-forge-text focus:border-forge-amber/60 focus:outline-none focus:ring-2 focus:ring-forge-amber/30"
                  placeholder="••••••"
                />
              </label>

              {error ? (
                <p
                  role="alert"
                  className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
                >
                  {error}
                </p>
              ) : null}

              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={onResend}
                  disabled={sending || verifying}
                  className="font-mono text-[10px] uppercase tracking-[0.25em] text-forge-dim underline-offset-4 transition hover:text-forge-text disabled:opacity-50"
                >
                  {sending ? 'Resending…' : 'Resend code'}
                </button>
                <button
                  type="submit"
                  disabled={verifying}
                  className="inline-flex items-center gap-2 rounded-xl border border-forge-amber/60 bg-forge-amber/15 px-5 py-3 font-mono text-xs uppercase tracking-[0.3em] text-forge-amber shadow-amber transition hover:bg-forge-amber/25 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {verifying ? 'Verifying…' : 'Verify & sign in'}
                </button>
              </div>

              <button
                type="button"
                onClick={() => {
                  setSent(false);
                  setCode('');
                  setError(null);
                  setNotice(null);
                }}
                className="mt-1 self-start font-mono text-[10px] uppercase tracking-[0.25em] text-forge-dim/70 underline-offset-4 transition hover:text-forge-dim"
              >
                ← Use a different email
              </button>
            </form>
          ) : (
            <form onSubmit={onSendCode} className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
                  email
                </span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={sending}
                  autoComplete="email"
                  required
                  className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 font-mono text-sm text-forge-text focus:border-forge-amber/60 focus:outline-none focus:ring-2 focus:ring-forge-amber/30"
                  placeholder="you@example.com"
                />
              </label>

              {error ? (
                <p
                  role="alert"
                  className="rounded-lg border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200"
                >
                  {error}
                </p>
              ) : null}

              <div className="flex items-center justify-end">
                <button
                  type="submit"
                  disabled={sending}
                  className="inline-flex items-center gap-2 rounded-xl border border-forge-amber/60 bg-forge-amber/15 px-5 py-3 font-mono text-xs uppercase tracking-[0.3em] text-forge-amber shadow-amber transition hover:bg-forge-amber/25 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {sending ? 'Sending…' : 'Send sign-in code'}
                </button>
              </div>
            </form>
          )}
        </div>
      </GlassPanel>
    </div>
  );
}

// useSearchParams() forces a client bail-out, which fails static prerender
// unless it sits under a Suspense boundary. Wrap the form so /sign-in builds.
export default function SignInPage() {
  return (
    <Suspense
      fallback={<div className="flex flex-1 items-center justify-center py-12" />}
    >
      <SignInForm />
    </Suspense>
  );
}
