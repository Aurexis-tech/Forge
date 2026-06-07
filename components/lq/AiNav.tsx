// AiNav — the AI-futuristic top nav for migrated pages. Reusable: the
// Landing migration was the first consumer; every subsequently-migrated
// page mounts this instead of the forge AppNav. The forge AppNav stays
// untouched for un-migrated routes. Pure presentation (the brand lockup
// + links + a LiquidGlass "Open" button); all the lockup styling lives
// in AiNav.module.css.
//
// BRAND LOCKUP — the 4-point aurora→violet spark mark + the gradient
// wordmark. The wordmark is REAL, selectable text (not an image) so it
// copies cleanly and screen-readers announce the brand name; the SVG is
// `aria-hidden` because it carries no semantic content beyond what the
// text already says. The lockup is STATIC — no pulse.

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
      {/* Brand lockup — preserved /; static (no pulse). */}
      <Link
        href="/"
        className={
          'group rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lq-aurora/60 ' +
          styles.brandLockup
        }
        aria-label="Aurexis Forge"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          xmlns="http://www.w3.org/2000/svg"
          className={styles.brandSpark}
        >
          <defs>
            <linearGradient
              id="aurexisSpark"
              x1="2"
              y1="2"
              x2="22"
              y2="22"
              gradientUnits="userSpaceOnUse"
            >
              <stop offset="0" stopColor="#5fe6ff" />
              <stop offset="1" stopColor="#a78bfa" />
            </linearGradient>
          </defs>
          <path
            d="M12 1.4C12.8 7.3 16.7 11.2 22.6 12C16.7 12.8 12.8 16.7 12 22.6C11.2 16.7 7.3 12.8 1.4 12C7.3 11.2 11.2 7.3 12 1.4Z"
            fill="url(#aurexisSpark)"
          />
        </svg>
        <span className={'font-ui ' + styles.brandWord}>Aurexis Forge</span>
      </Link>

      {/* Center links. */}
      <div className="hidden items-center gap-7 md:flex">
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="rounded text-sm font-medium text-lq-ink-dim transition-colors duration-200 hover:text-lq-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lq-aurora/60"
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
        Launch
      </LiquidGlass>
    </nav>
  );
}
