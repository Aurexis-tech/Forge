// PROVIDER-CONNECTION RESOLUTION + DEPLOY WIRING.
//
// Provider-backed tools (web_search → Brave, future fetch/communicate
// tools) declare a `provider_connection` on the contract. This module
// turns a build's selected tools into:
//   - the set of provider connections the build REQUIRES, and
//   - the SERVER-ONLY env vars to wire into the deployed agent (env_key
//     → decrypted key), or a typed NeedsConnectionError when the key
//     isn't connected yet.
//
// The key flows to the DEPLOYED AGENT (it runs on the user's provider
// account + quota). The ENGINE never calls the provider API and never
// meters it. The key is resolved from the SAME encrypted connection
// store every other connection uses (lib/crypto via
// loadConnectionWithToken) — no parallel connection system.
//
// SERVER-ONLY: a provider env var is always wired secret + never
// NEXT_PUBLIC_ (asserted here AND at registration via the contract).

import type { ToolProviderConnection } from './contract';
import { getToolByName, listTools } from './registry';
// Type-only import — keeps this module out of the vercel.ts runtime
// import graph (avoids a cycle through retry/errors).
import type { VercelEnvVar } from '../integrations/vercel';

/**
 * Thrown when a build selects a provider-backed tool but the user
 * hasn't connected the required key. Carries the provider + env_key +
 * setup_url so the deploy route can surface a "connect your key" gate
 * (analogous to NeedsKeyError → 412). Classified as `auth` by
 * lib/engine/errors.ts (duck-typed on `name`).
 */
export class NeedsConnectionError extends Error {
  readonly provider: string;
  readonly env_key: string;
  readonly setup_url: string | null;
  readonly label: string;

  constructor(conn: ToolProviderConnection) {
    super('needs_connection:' + conn.provider);
    this.name = 'NeedsConnectionError';
    this.provider = conn.provider;
    this.env_key = conn.env_key;
    this.setup_url = conn.setup_url ?? null;
    this.label = conn.label;
  }
}

/**
 * Compute the provider connections a build requires, from the names of
 * the tools it selected. De-duplicated by `provider`, ordered by
 * first appearance. Internal-only builds yield [].
 */
export function requiredProviderConnections(
  toolNames: ReadonlyArray<string>,
): ToolProviderConnection[] {
  const out: ToolProviderConnection[] = [];
  const seen = new Set<string>();
  for (const name of toolNames) {
    const tool = getToolByName(name);
    const pc = tool?.provider_connection;
    if (!pc) continue;
    if (seen.has(pc.provider)) continue;
    seen.add(pc.provider);
    out.push(pc);
  }
  return out;
}

/**
 * The UNIQUE set of provider connections across ALL registered tools,
 * de-duplicated by `provider` (multiple tools may share one) and
 * ordered by provider id for stable rendering. Registry-derived: a
 * new provider-backed tool appears here automatically, so the
 * settings UI gets a panel with no per-tool work.
 *
 * Today this is just brave_search (from web_search). An internal-only
 * registry yields [].
 */
export function listToolProviderConnections(): ToolProviderConnection[] {
  const byProvider = new Map<string, ToolProviderConnection>();
  for (const tool of listTools()) {
    const pc = tool.provider_connection;
    if (pc && !byProvider.has(pc.provider)) byProvider.set(pc.provider, pc);
  }
  return Array.from(byProvider.values()).sort((a, b) =>
    a.provider.localeCompare(b.provider),
  );
}

/** A key-lookup seam: provider id → decrypted key (or null if not connected). */
export type ProviderKeyLookup = (provider: string) => Promise<string | null>;

/**
 * Resolve the SERVER-ONLY env vars to wire into a deployed agent for
 * its provider-backed tools. For each required connection:
 *   - look the key up via `lookupKey` (the route passes one backed by
 *     the encrypted connection store),
 *   - if missing → throw NeedsConnectionError (no half-wired deploy),
 *   - else → emit { key: env_key, value, secret: true }.
 *
 * Hard-asserts no env_key is NEXT_PUBLIC_ (defence in depth; the
 * contract already forbids it at registration).
 */
export async function buildProviderConnectionEnv(args: {
  toolNames: ReadonlyArray<string>;
  lookupKey: ProviderKeyLookup;
}): Promise<VercelEnvVar[]> {
  const required = requiredProviderConnections(args.toolNames);
  const env: VercelEnvVar[] = [];
  for (const conn of required) {
    if (conn.env_key.startsWith('NEXT_PUBLIC_')) {
      // Unreachable if registration validated, but never wire a
      // provider key into a public var.
      throw new Error(
        'provider connection ' +
          conn.provider +
          ' env_key must be SERVER-ONLY (never NEXT_PUBLIC_)',
      );
    }
    const value = await args.lookupKey(conn.provider);
    if (value == null || value.trim().length === 0) {
      throw new NeedsConnectionError(conn);
    }
    env.push({ key: conn.env_key, value, secret: true });
  }
  return env;
}
