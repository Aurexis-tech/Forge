import Link from 'next/link';
import { ConnectionsForm } from '@/components/connections/ConnectionsForm';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function ConnectionsSettingsPage() {
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
            settings · connections
          </p>
          <h1 className="mt-2 text-3xl font-medium text-forge-text">
            GitHub &amp; Vercel
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-forge-dim">
            Connect the integrations a forged project needs to leave the
            sandbox: GitHub to push the generated repo, Vercel to deploy it.
            Connect them once here BEFORE you run a forge so the build → push
            → deploy flow never stalls on a missing credential.
          </p>
          <p className="mt-3 max-w-2xl text-xs text-forge-dim">
            Need API keys (Anthropic / E2B) instead?{' '}
            <Link
              href="/settings/keys"
              className="text-forge-cyan hover:text-forge-text"
            >
              Go to /settings/keys →
            </Link>
          </p>
        </div>
      </header>

      <ConnectionsForm />
    </section>
  );
}
