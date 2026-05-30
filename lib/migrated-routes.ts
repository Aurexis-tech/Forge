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
  '/governance',
];

/** Pattern matchers for migrated dynamic routes. Each pattern MUST be
 *  anchored (^…$) so it matches the FULL pathname — otherwise something
 *  like /projects/[id]/runs would also match. Patterns are checked AFTER
 *  the exact list (the exact list always wins). The final cleanup prompt
 *  deletes this array along with the switch. */
export const MIGRATED_PATTERNS: readonly RegExp[] = [
  // /projects/[id] — the workshop page. Deeper children (e.g. a
  // hypothetical /projects/[id]/runs) deliberately stay un-migrated.
  /^\/projects\/[^/]+$/,
];

/**
 * True when `pathname` is a migrated route. EXACT match against
 * `MIGRATED_ROUTES`, then anchored pattern match against
 * `MIGRATED_PATTERNS`. Each page opts in deliberately, so an un-migrated
 * dynamic child route still goes to ForgeBackdrop. Null-safe for
 * usePathname().
 */
export function isMigratedRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  if (MIGRATED_ROUTES.includes(pathname)) return true;
  for (const pattern of MIGRATED_PATTERNS) {
    if (pattern.test(pathname)) return true;
  }
  return false;
}
