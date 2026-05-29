// AiNav — the AI-futuristic top nav for migrated pages. Reusable: the
// Landing migration is the first consumer; subsequent migrated pages mount
// this instead of the forge AppNav. The forge AppNav stays untouched for
// un-migrated routes. Pure presentation (links + a LiquidGlass "Open"
// button); the brand dot pulse lives in AiNav.module.css.

import Link from 'next/link';
import { LiquidGlass } from '@/components/lq/LiquidGlass';
import styles from './AiNav.module.css';

const LINKS: ReadonlyArray<{ label: string; href: string }> = [
  { label: 'Intake', href: '/forge' },
  { label: 'Projects', href: '/projects' },
  { label: 'Keys', href: '/settings/keys' },
  { label: 'Governance', href: '/governance' },
];

export function AiNav() {
  return (
    <nav className="relative z-20 flex items-center justify-between gap-6 px-6 py-5 font-ui sm:px-10">
      {/* Brand mark — pulsing aurora dot + wordmark. */}
      <Link href="/" className="group flex items-center gap-3">
        <span aria-hidden className={styles.brandDot} />
        <span className="text-sm font-semibold tracking-tight text-lq-ink">
          Aurexis Forge
        </span>
      </Link>

      {/* Center links. */}
      <div className="hidden items-center gap-7 md:flex">
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="text-sm font-medium text-lq-ink-dim transition-colors duration-200 hover:text-lq-ink"
          >
            {l.label}
          </Link>
        ))}
      </div>

      {/* Open the forge — a LiquidGlass anchor (navigates; links beat
          onClick buttons for the front door). */}
      <LiquidGlass
        as="a"
        href="/forge"
        variant="aurora"
        className="inline-flex items-center rounded-[14px] px-5 py-2.5 text-sm font-medium"
      >
        Open
      </LiquidGlass>
    </nav>
  );
}
