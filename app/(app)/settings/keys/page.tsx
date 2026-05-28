import Link from 'next/link';
import { SectionHeader } from '@/components/forge/SectionHeader';
import { Reveal } from '@/components/Reveal';
import { KeysForm } from '@/components/keys/KeysForm';
import { requireUser } from '@/lib/auth';
import { MOTION } from '@/lib/forge-motion';

export const dynamic = 'force-dynamic';

export default async function KeysSettingsPage() {
  await requireUser();
  return (
    <section className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 py-12">
      <Reveal>
        <div className="flex flex-col gap-4">
          <Link
            href="/projects"
            className="font-mono text-[10px] uppercase tracking-[0.3em] text-forge-dim hover:text-forge-text"
          >
            ← projects
          </Link>
          <SectionHeader
            level={1}
            eyebrow="settings · keys"
            title="Your API keys"
            subcopy="The Forge runs every spec extraction, plan, codegen, sandbox test, and live runtime on the keys you bring. Connecting a key costs nothing here — you pay the provider directly. Disconnect any time."
          />
          <p className="max-w-2xl text-xs text-forge-dim">
            Need to wire GitHub / Vercel instead?{' '}
            <Link
              href="/settings/connections"
              className="text-cool-cyan hover:text-forge-text"
            >
              Go to /settings/connections →
            </Link>
          </p>
        </div>
      </Reveal>

      <Reveal delayMs={MOTION.revealStep}>
        <KeysForm />
      </Reveal>
    </section>
  );
}
