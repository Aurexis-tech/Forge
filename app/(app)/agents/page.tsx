// /agents — MIGRATED to AI-futuristic via the parameterized MoldSpaceAi.
// Backdrop + AiNav come from the AppBackdrop / AppShellHeader switches
// automatically (/agents is in MIGRATED_ROUTES).

import { MoldSpaceAi } from '@/components/projects-ai/MoldSpaceAi';

export const dynamic = 'force-dynamic';

export default function AgentsPage() {
  return <MoldSpaceAi mold="agent" />;
}
