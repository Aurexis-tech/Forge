// Unit tests — listToolProviderConnections + verifyProviderKey.
// Hermetic: verifyProviderKey takes an INJECTABLE fetch, so zero real
// provider calls.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  _resetRegistryForTests,
  _resetSeedFlagForTests,
  ensureToolsRegistered,
  listToolProviderConnections,
  registerTool,
  verifyProviderKey,
  type ToolProviderConnection,
  type VerifyFetch,
} from '@/lib/engine/tools';
import type { ToolDefinition } from '@/lib/engine/tools';

afterEach(() => {
  _resetRegistryForTests();
  _resetSeedFlagForTests();
  ensureToolsRegistered();
});

const BRAVE: ToolProviderConnection = {
  provider: 'brave_search',
  label: 'Brave Search',
  env_key: 'BRAVE_SEARCH_API_KEY',
  setup_url: 'https://api-dashboard.search.brave.com/',
  verify: {
    url: 'https://api.search.brave.com/res/v1/web/search?q=test',
    method: 'GET',
    header: 'X-Subscription-Token',
  },
};

// ===========================================================================
// listToolProviderConnections
// ===========================================================================
describe('listToolProviderConnections', () => {
  it('returns brave_search (from web_search) in the default registry', () => {
    const list = listToolProviderConnections();
    const brave = list.find((c) => c.provider === 'brave_search');
    expect(brave).toBeDefined();
    expect(brave!.env_key).toBe('BRAVE_SEARCH_API_KEY');
    expect(brave!.label).toBe('Brave Search');
  });

  it('dedupes by provider when multiple tools share a connection', () => {
    _resetRegistryForTests();
    _resetSeedFlagForTests();
    const mk = (name: string): ToolDefinition => ({
      name,
      description: 'shares the brave connection',
      category: 'fetch',
      capabilities: { reads_network: true, writes_external: false, destructive: false },
      input_schema: z.object({ q: z.string() }),
      output_schema: z.object({ r: z.string() }),
      runtime: async () => ({ r: 'x' }),
      mock: async () => ({ r: 'x' }),
      examples: [
        { label: 'a', input: { q: '1' }, output: { r: 'x' } },
        { label: 'b', input: { q: '2' }, output: { r: 'x' } },
      ],
      scaffoldSource: 'export const x = 1;\n',
      scaffoldInterfaceSignature: 'export const ' + name + ': unknown;',
      plannerLabel: name,
      envKeys: [],
      status: 'available',
      provider_connection: BRAVE,
    });
    registerTool(mk('tool_a'));
    registerTool(mk('tool_b'));
    const list = listToolProviderConnections();
    expect(list.filter((c) => c.provider === 'brave_search')).toHaveLength(1);
  });

  it('an internal-only registry yields []', () => {
    _resetRegistryForTests();
    _resetSeedFlagForTests();
    registerTool({
      name: 'internal_only',
      description: 'no network',
      category: 'compute',
      capabilities: { reads_network: false, writes_external: false, destructive: false },
      input_schema: z.object({ x: z.number() }),
      output_schema: z.object({ y: z.number() }),
      runtime: async (i) => ({ y: (i as { x: number }).x }),
      mock: async (i) => ({ y: (i as { x: number }).x }),
      examples: [
        { label: 'a', input: { x: 1 }, output: { y: 1 } },
        { label: 'b', input: { x: 2 }, output: { y: 2 } },
      ],
      scaffoldSource: 'export const x = 1;\n',
      scaffoldInterfaceSignature: 'export const internal_only: unknown;',
      plannerLabel: 'Internal only',
      envKeys: [],
      status: 'available',
    });
    expect(listToolProviderConnections()).toEqual([]);
  });
});

// ===========================================================================
// verifyProviderKey
// ===========================================================================
describe('verifyProviderKey — injectable fetch (zero real calls)', () => {
  it('builds the request from the declared verify shape (url/method/header carries the key)', async () => {
    const calls: Array<{ url: string; init: { method: string; headers: Record<string, string> } }> = [];
    const mockFetch: VerifyFetch = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200 };
    };
    const result = await verifyProviderKey(BRAVE, 'bsk-secret-key', mockFetch);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(BRAVE.verify!.url);
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.headers['X-Subscription-Token']).toBe('bsk-secret-key');
    expect(calls[0]!.init.headers['Accept']).toBe('application/json');
  });

  it('ok:true on 2xx', async () => {
    const result = await verifyProviderKey(BRAVE, 'k', async () => ({ ok: true, status: 200 }));
    expect(result.ok).toBe(true);
  });

  it('ok:false on 401 (rejected key)', async () => {
    const result = await verifyProviderKey(BRAVE, 'k', async () => ({ ok: false, status: 401 }));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('ok:false on 500 (provider error)', async () => {
    const result = await verifyProviderKey(BRAVE, 'k', async () => ({ ok: false, status: 500 }));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
  });

  it('a network failure → ok:false with the error in warn', async () => {
    const result = await verifyProviderKey(BRAVE, 'k', async () => {
      throw new Error('ECONNRESET');
    });
    expect(result.ok).toBe(false);
    expect(result.warn).toMatch(/ECONNRESET/);
  });

  it('a connection with NO verify shape → ok:true + structured warn (cannot probe)', async () => {
    const noVerify: ToolProviderConnection = {
      provider: 'p',
      label: 'P',
      env_key: 'P_KEY',
    };
    const spy = vi.fn();
    const result = await verifyProviderKey(noVerify, 'k', spy as unknown as VerifyFetch);
    expect(result.ok).toBe(true);
    expect(result.warn).toMatch(/no verify shape/);
    expect(spy).not.toHaveBeenCalled(); // never fetches
  });
});
