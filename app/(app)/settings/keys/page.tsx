// /settings/keys — MIGRATED to AI-futuristic. Backdrop + AiNav come from
// the AppBackdrop / AppShellHeader switches (this route is in
// MIGRATED_ROUTES). The KEY-MANAGEMENT WIRING IS PRESERVED EXACTLY — the
// client still hits the same /api/connections/keys endpoint with the same
// GET / POST / DELETE shapes.
//
// The page is a server component that loads the REAL OAuth connection
// status for the three platform integrations (GitHub / Vercel / Supabase)
// in parallel via the EXISTING loadConnectionPublic helper, and hands
// the public-safe snapshot to KeysAi as initial props. Connect / Manage
// affordances on those OAuth cards LINK OUT to /settings/connections —
// the OAuth handshake + disconnect logic still lives there; we just
// READ status here.

import { KeysAi } from '@/components/keys-ai/KeysAi';
import { OAUTH_PROVIDERS, type OAuthSnapshotByProvider } from '@/lib/keys-config';
import { requireUser } from '@/lib/auth';
import { loadConnectionPublic } from '@/lib/engine/integrations/connections';
import { getServerSupabase } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

async function loadOauthSnapshots(userId: string): Promise<OAuthSnapshotByProvider> {
  const supabase = getServerSupabase();
  const entries = await Promise.all(
    OAUTH_PROVIDERS.map(async (p) => {
      try {
        const row = await loadConnectionPublic(supabase, p.provider, userId);
        return [
          p.provider,
          {
            connected: !!row,
            account_login: row?.account_login ?? null,
            connected_at: row?.created_at ?? null,
          },
        ] as const;
      } catch {
        // Loader failure → render the card honestly as "not connected"
        // (instead of throwing the whole page).
        return [
          p.provider,
          { connected: false, account_login: null, connected_at: null },
        ] as const;
      }
    }),
  );
  return Object.fromEntries(entries) as OAuthSnapshotByProvider;
}

export default async function KeysSettingsPage() {
  const user = await requireUser();
  const oauthInitial = await loadOauthSnapshots(user.id);
  return <KeysAi oauthInitial={oauthInitial} />;
}
