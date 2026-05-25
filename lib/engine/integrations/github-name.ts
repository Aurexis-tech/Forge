// Pure repo-name derivation. Lives in its own module so client components
// can preview the proposed name without pulling Octokit into the bundle.
//
// Keep in sync with `lib/engine/integrations/github.ts` — they MUST agree
// on the base name; the server is the only place suffix resolution happens.

export function deriveRepoName(projectName: string): string {
  let base = projectName
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  if (!base) base = 'forge-agent';
  if (!/^[a-z0-9]/.test(base)) base = 'a' + base;
  return base;
}
