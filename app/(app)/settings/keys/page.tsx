// /settings/keys — MIGRATED to AI-futuristic. Backdrop + AiNav come from
// the AppBackdrop / AppShellHeader switches (this route is in
// MIGRATED_ROUTES). The KEY-MANAGEMENT WIRING IS PRESERVED EXACTLY — the
// client still hits the same /api/connections/keys endpoint with the same
// GET / POST / DELETE shapes; only the shell is restyled.

import { KeysAi } from '@/components/keys-ai/KeysAi';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function KeysSettingsPage() {
  await requireUser();
  return <KeysAi />;
}
