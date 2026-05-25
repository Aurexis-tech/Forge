import Link from 'next/link';
import { KeysForm } from '@/components/keys/KeysForm';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function KeysSettingsPage() {
  await requireUser();
  return (
    <section className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 py-12">
      <header>
        <Link
          href="/projects"
          className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim hover:text-forge-text"
        >
          ← projects
        </Link>
        <div className="mt-3">
          <p className="font-mono text-[10px] uppercase tracking-[0.4em] text-forge-amber">
            settings · keys
          </p>
          <h1 className="mt-2 text-3xl font-medium text-forge-text">
            Your API keys
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-forge-dim">
            The Forge runs every spec extraction, plan, codegen, sandbox
            test, and live runtime on the keys you bring. Connecting a key
            costs nothing here — you pay the provider directly. Disconnect
            any time.
          </p>
          <p className="mt-3 max-w-2xl text-xs text-forge-dim">
            Need to wire GitHub / Vercel instead?{' '}
            <Link
              href="/settings/connections"
              className="text-forge-cyan hover:text-forge-text"
            >
              Go to /settings/connections →
            </Link>
          </p>
        </div>
      </header>

      <KeysForm />
    </section>
  );
}
