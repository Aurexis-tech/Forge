// THE single source of transitional truth for the forge → AI-futuristic
// migration inside the (app) group. As each (app) page is migrated, add its
// route here; the AppBackdrop + AppShellHeader switches consult this to
// decide which backdrop + nav to render. The final cleanup prompt deletes
// this file (and the switches + ForgeBackdrop) once everything is migrated.

/** Routes (under the (app) group) that have moved to the AI-futuristic
 *  design language — they get AurexisAmbient + AiNav. Everything else
 *  keeps ForgeBackdrop + the forge AppNav. */
export const MIGRATED_ROUTES: readonly string[] = [
  '/forge',
  '/projects',
  '/agents',
  '/systems',
  '/software',
  '/infrastructure',
  '/settings/keys',
];

/**
 * True when `pathname` is a migrated route. EXACT match only: each page
 * opts in deliberately, so /projects can be migrated without dragging
 * /projects/[id] (the un-migrated detail page) into the aurora shell.
 * Null-safe for usePathname().
 */
export function isMigratedRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return MIGRATED_ROUTES.includes(pathname);
}
