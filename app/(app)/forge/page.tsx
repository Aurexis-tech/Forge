// The signed-in intake. "/" is the public landing for logged-out
// visitors; this route is what the landing's CTAs and the in-app nav
// point to for an authenticated user starting a new project.

import { IntakeForm } from '@/components/IntakeForm';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function ForgeIntakePage() {
  // requireUser throws (-> middleware redirect) for logged-out callers,
  // so the intake form only ever renders for authenticated users.
  await requireUser();
  return (
    <div className="flex flex-1 items-center justify-center py-12">
      <IntakeForm />
    </div>
  );
}
