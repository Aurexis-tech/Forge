// SCAFFOLD DEPENDENCY MERGE — turns a tool's declared
// `scaffoldDependencies` into real entries in the generated
// project's package.json.
//
// WHY
//   A build that selects `compute_math` ships source that
//   `import { evaluate } from 'mathjs'`. If mathjs isn't in the
//   generated package.json, the deployed agent crashes at runtime.
//   This module closes the gap: the deps of the tools a build
//   ACTUALLY uses are merged on top of the base package.json deps.
//
// PER-BUILD, NOT GLOBAL
//   The caller passes the names of the tools the build selected
//   (agent: plan.tools; system: union of node suggested_tools).
//   Only those tools' deps are merged — an agent that does no math
//   never ships mathjs.
//
// CONFLICT RULE
//   If two selected tools declare the SAME package at DIFFERENT
//   versions, the build fails with a typed bad_input EngineError
//   (code 'tool_dependency_conflict') rather than silently picking
//   one. Same package at the same version dedupes cleanly. (Only
//   mathjs exists today, so this never fires now — the rule exists
//   to prevent a future silent break.)
//
// STABILITY
//   The merged package.json keeps the base top-level key order and
//   sorts the `dependencies` keys alphabetically, so the same
//   selected-tool set always produces byte-identical output
//   (reproducible, diff-friendly builds).

import { badInputError } from '../errors';
import { getToolByName } from './registry';

/**
 * Collect the union of `scaffoldDependencies` across the named
 * tools. Unknown names contribute nothing (the planner already
 * validates registry_ids; a missing tool simply has no deps).
 *
 * Throws `bad_input` / 'tool_dependency_conflict' when two tools
 * declare the same package at different versions.
 */
export function collectToolDependencies(
  toolNames: ReadonlyArray<string>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  const declaredBy: Record<string, string> = {};
  for (const name of toolNames) {
    const tool = getToolByName(name);
    const deps = tool?.scaffoldDependencies;
    if (!deps) continue;
    for (const [pkg, version] of Object.entries(deps)) {
      const existing = merged[pkg];
      if (existing !== undefined && existing !== version) {
        throw badInputError(
          'tool_dependency_conflict',
          "tool '" +
            name +
            "' requires " +
            pkg +
            '@' +
            version +
            " but tool '" +
            (declaredBy[pkg] ?? '?') +
            "' already requires " +
            pkg +
            '@' +
            existing,
          'Two selected tools need conflicting versions of ' +
            pkg +
            '. Remove one or align their versions.',
        );
      }
      if (existing === undefined) declaredBy[pkg] = name;
      merged[pkg] = version;
    }
  }
  return merged;
}

/**
 * Merge the selected tools' scaffold dependencies into a base
 * package.json string and return the new package.json string.
 *
 * - Base top-level key order is preserved (name, version, …,
 *   dependencies, devDependencies).
 * - Tool deps merge additively ON TOP of base `dependencies`.
 * - The final `dependencies` object is sorted by key for stable,
 *   diff-friendly output.
 * - devDependencies + everything else are untouched.
 *
 * When the selected tools declare no deps, the output is
 * byte-identical to the base (single-key base dependencies sorts to
 * itself + re-serialisation reproduces the original 2-space JSON).
 */
export function mergePackageJsonDependencies(
  basePackageJson: string,
  toolNames: ReadonlyArray<string>,
): string {
  const toolDeps = collectToolDependencies(toolNames);

  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(basePackageJson) as Record<string, unknown>;
  } catch (err) {
    throw badInputError(
      'package_json_unparseable',
      'base package.json is not valid JSON: ' +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  const baseDeps: Record<string, string> =
    pkg.dependencies && typeof pkg.dependencies === 'object'
      ? (pkg.dependencies as Record<string, string>)
      : {};

  // Tool deps additive on top of base. (No overlap exists today;
  // a tool that names a base package at the same version is a no-op,
  // at a different version it overrides — base deps remain the floor
  // for every package the base already pins.)
  const mergedDeps: Record<string, string> = { ...baseDeps, ...toolDeps };

  // Sort dependency keys for stable ordering.
  const sortedDeps: Record<string, string> = {};
  for (const key of Object.keys(mergedDeps).sort()) {
    sortedDeps[key] = mergedDeps[key]!;
  }

  // Reassigning an existing key preserves its position in the
  // top-level object, so the base key order is unchanged.
  pkg.dependencies = sortedDeps;

  return JSON.stringify(pkg, null, 2) + '\n';
}

/**
 * Compute the de-duplicated, order-stable list of tool names a build
 * selected, from a raw list of (possibly null / repeated)
 * registry_ids. First-seen order is preserved.
 */
export function dedupeSelectedToolNames(
  registryIds: ReadonlyArray<string | null>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of registryIds) {
    if (id === null) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
