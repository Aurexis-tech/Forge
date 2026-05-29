// /projects — MIGRATED to the AI-futuristic design language. The aurora
// backdrop + AiNav come from the AppBackdrop / AppShellHeader switches
// (this route is now in MIGRATED_ROUTES). The page itself remains a
// server component: it loads the REAL project list via loadProjectCards
// (unchanged loader — same query, same newest-first order, same shape)
// and hands it to the client ProjectsAi which renders chips/sort/grid +
// the first-class empty state.

import { ProjectsAi } from '@/components/projects-ai/ProjectsAi';
import { requireUser } from '@/lib/auth';
import { loadProjectCards } from '@/lib/project-cards';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage() {
  const user = await requireUser();
  const cards = await loadProjectCards(user.id);
  return <ProjectsAi cards={cards} />;
}
