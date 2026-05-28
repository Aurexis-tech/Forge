import Link from 'next/link';
import { CloudConnectionPanel } from '@/components/connections/CloudConnectionPanel';
import { ConnectionsForm } from '@/components/connections/ConnectionsForm';
import { SupabaseConnectionPanel } from '@/components/connections/SupabaseConnectionPanel';
import { ToolProviderKeysSection } from '@/components/connections/ToolProviderKeysSection';
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
            Integrations &amp; cloud
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-forge-dim">
            Connect the integrations a forged project needs to leave the
            sandbox. GitHub + Vercel cover agent / system / software push +
            deploy. Supabase Management enables the managed DB provisioning
            path for software apps. Cloud credentials power the Phase 4
            infrastructure pipeline. Connect each ONCE here BEFORE you run
            a forge so the gates never stall on a missing credential.
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

      {/* GitHub + Vercel panels — untouched. The original
          ConnectionsForm renders both. */}
      <ConnectionsForm />

      {/* P3-5a managed-DB path credential. */}
      <SupabaseConnectionPanel />

      {/* P4-5a real plan + P4-5b apply credential. Strongest guidance
          on the page — render LAST so it's the user's parting
          impression before they paste real cloud keys. */}
      <CloudConnectionPanel />

      {/* Agent tool keys — keys the user's DEPLOYED AGENTS use (e.g.
          Brave Search for web_search). Registry-driven + visually
          distinct from the platform connections above. Renders nothing
          when no provider-backed tool is registered. */}
      <ToolProviderKeysSection />
    </section>
  );
}
