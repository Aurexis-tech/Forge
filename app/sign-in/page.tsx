'use client';

// Magic-link sign-in. We use Supabase Auth's email OTP / magic link flow —
// no passwords, no third-party OAuth at this layer. The Forge's
// integration OAuth flows (GitHub, Vercel) live elsewhere and are
// orthogonal to platform auth.

import { Suspense, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';
import { GlassPanel } from '@/components/GlassPanel';

function SignInForm() {
  const params = useSearchParams();
  const next = params.get('next') ?? '/projects';
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const trimmed = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError('Enter a valid email address.');
      return;
    }
    setSubmitting(true);
    try {
      const supabase = createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      );
      const redirectTo =
        (typeof window !== 'undefined' ? window.location.origin : '') +
        '/auth/callback?next=' +
        encodeURIComponent(next);
      const { error: signErr } = await supabase.auth.signInWithOtp({
        email: trimmed,
        options: { emailRedirectTo: redirectTo },
      });
      if (signErr) throw signErr;
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setSubmitting(false);
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
              A magic link will be sent to your inbox. No password.
            </p>
          </div>

          {sent ? (
            <div className="rounded-lg border border-forge-amber/40 bg-forge-amber/[0.06] p-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-amber">
                check your inbox
              </p>
              <p className="mt-1 text-sm text-forge-text/90">
                We sent a sign-in link to <span className="font-mono">{email}</span>.
                Click it to come back here.
              </p>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="flex flex-col gap-3">
              <label className="flex flex-col gap-1.5">
                <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim">
                  email
                </span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={submitting}
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
                  disabled={submitting}
                  className="inline-flex items-center gap-2 rounded-xl border border-forge-amber/60 bg-forge-amber/15 px-5 py-3 font-mono text-xs uppercase tracking-[0.3em] text-forge-amber shadow-amber transition hover:bg-forge-amber/25 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? 'Sending…' : 'Send magic link'}
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
