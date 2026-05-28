'use client';

// The in-app nav. The four molds are the primary spine (Home + Agents ·
// Systems · Software · Infrastructure); "+ New Forge" is the single
// unified intake action; Keys + Governance are global utilities, visually
// secondary. Active state comes from the current path via usePathname.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  GLOBAL_NAV,
  isNavActive,
  NEW_FORGE_HREF,
  PRIMARY_NAV,
  type NavItem,
} from '@/lib/nav';

export function AppNav() {
  const pathname = usePathname() ?? '';

  return (
    <nav className="flex flex-wrap items-center justify-end gap-x-5 gap-y-2 font-mono text-xs uppercase tracking-[0.3em]">
      {/* Primary spine — the four molds + Home. */}
      {PRIMARY_NAV.map((item) => {
        const active = isNavActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={
              active
                ? 'text-forge-amber'
                : 'text-forge-dim transition hover:text-forge-text'
            }
          >
            {item.label}
          </Link>
        );
      })}

      {/* Unified intake action. */}
      <Link
        href={NEW_FORGE_HREF}
        className="rounded-xl border border-white/10 px-3 py-1.5 text-forge-dim transition hover:border-forge-amber/50 hover:text-forge-amber"
      >
        + New&nbsp;Forge
      </Link>

      {/* Global utilities — secondary, set off by a hairline divider. */}
      <span aria-hidden className="hidden h-3 w-px bg-white/10 sm:inline-block" />
      {GLOBAL_NAV.map((item) => (
        <GlobalLink
          key={item.href}
          item={item}
          active={isNavActive(pathname, item.href)}
        />
      ))}
    </nav>
  );
}

// Literal class strings per accent — Tailwind's JIT only sees complete
// class literals in source, so we must NOT build them by concatenation.
const GLOBAL_LINK_CLASS: Record<'amber' | 'cyan', { active: string; idle: string }> = {
  amber: {
    active: 'text-[11px] text-forge-amber',
    idle: 'text-[11px] text-forge-dim/80 transition hover:text-forge-amber',
  },
  cyan: {
    active: 'text-[11px] text-forge-cyan',
    idle: 'text-[11px] text-forge-dim/80 transition hover:text-forge-cyan',
  },
};

function GlobalLink({ item, active }: { item: NavItem; active: boolean }) {
  const cls = GLOBAL_LINK_CLASS[item.accent === 'cyan' ? 'cyan' : 'amber'];
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className={active ? cls.active : cls.idle}
    >
      {item.label}
    </Link>
  );
}
