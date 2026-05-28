// Mold pill — surfaces which mold a project belongs to, styled like the
// journey stage pill (mono, uppercase, bordered). Reuses MOLD_META so the
// label + tone stay in one place. 'unclassified' renders the quiet
// "detecting…" badge so a fresh forge is never mislabeled as an agent.

import { HeatBadge } from '@/components/forge/HeatBadge';
import { MOLD_META, type ProjectMold } from '@/lib/molds';

export function MoldBadge({
  mold,
  className = '',
}: {
  mold: ProjectMold;
  className?: string;
}) {
  const meta = MOLD_META[mold];
  // The mold tones are brand-coded (agent=amber, system=cyan, …); pass
  // them straight through the HeatBadge pill primitive so every badge in
  // the app shares one shape + sizing.
  return (
    <HeatBadge tone={meta.tone} className={className}>
      {meta.badgeLabel}
    </HeatBadge>
  );
}
