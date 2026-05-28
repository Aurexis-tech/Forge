// Provider-backed tool pattern — web_search (Brave) as the reference.
//
// Hermetic — ZERO real search calls. Exercises:
//   - contract: a provider_connection tool declaring reads_network:false
//     is REJECTED at registration.
//   - web_search: declares the brave_search provider_connection; engine
//     mock is deterministic + does no I/O; scaffoldSource self-mocks;
//     examples parse.
//   - resolver: requiredProviderConnections for a web_search build vs an
//     internal-only build.
//   - deploy gate: missing key → NeedsConnectionError; present key →
//     SERVER-ONLY env (secret, never NEXT_PUBLIC).
//   - NeedsConnectionError classifies as `auth`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  _resetRegistryForTests,
  _resetSeedFlagForTests,
  buildProviderConnectionEnv,
  callTool,
  ensureToolsRegistered,
  getToolByName,
  NeedsConnectionError,
  registerTool,
  requiredProviderConnections,
  WEB_SEARCH_TOOL,
} from '@/lib/engine/tools';
import type { ToolDefinition } from '@/lib/engine/tools';
import { classifyError } from '@/lib/engine/errors';

afterEach(() => {
  _resetRegistryForTests();
  _resetSeedFlagForTests();
  ensureToolsRegistered();
});

// ===========================================================================
// CONTRACT — provider-backed tools must declare reads_network:true
// ===========================================================================
describe('contract — provider_connection requires reads_network:true', () => {
  beforeEach(() => {
    _resetRegistryForTests();
  });

  function providerTool(over: Partial<ToolDefinition> = {}): ToolDefinition {
    return {
      name: 'test_provider_tool',
      description: 'a provider-backed test tool',
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
      scaffoldInterfaceSignature: 'export const test_provider_tool: unknown;',
      plannerLabel: 'Test provider tool',
      envKeys: [],
      status: 'available',
      provider_connection: {
        provider: 'test_provider',
        label: 'Test Provider',
        env_key: 'TEST_PROVIDER_API_KEY',
        setup_url: 'https://example.com/keys',
      },
      ...over,
    };
  }

  it('a provider_connection tool declaring reads_network:false is REJECTED at registration', () => {
    expect(() =>
      registerTool(
        providerTool({
          capabilities: { reads_network: false, writes_external: false, destructive: false },
        }),
      ),
    ).toThrow(/reads_network:true/);
  });

  it('a provider_connection tool with reads_network:true registers cleanly', () => {
    expect(() => registerTool(providerTool())).not.toThrow();
  });

  it('a provider_connection with a NEXT_PUBLIC_ env_key is REJECTED', () => {
    expect(() =>
      registerTool(
        providerTool({
          provider_connection: {
            provider: 'test_provider',
            label: 'Test',
            env_key: 'NEXT_PUBLIC_TEST_KEY',
          },
        }),
      ),
    ).toThrow(/SERVER-ONLY/);
  });
});

// ===========================================================================
// web_search FIRST-CLASS (Brave)
// ===========================================================================
describe('web_search — provider-backed (Brave)', () => {
  it('declares the brave_search provider_connection with the right env_key + verify shape', () => {
    const pc = WEB_SEARCH_TOOL.provider_connection;
    expect(pc).toBeDefined();
    expect(pc!.provider).toBe('brave_search');
    expect(pc!.label).toBe('Brave Search');
    expect(pc!.env_key).toBe('BRAVE_SEARCH_API_KEY');
    expect(pc!.setup_url).toBe('https://api-dashboard.search.brave.com/');
    expect(pc!.verify?.header).toBe('X-Subscription-Token');
    expect(pc!.verify?.method).toBe('GET');
  });

  it('declares reads_network:true (honest — it reaches Brave)', () => {
    expect(WEB_SEARCH_TOOL.capabilities.reads_network).toBe(true);
    expect(WEB_SEARCH_TOOL.capabilities.writes_external).toBe(false);
  });

  it('scaffoldSource self-mocks on FORGE_MOCK_TOOLS=1 + uses the verified Brave endpoint/header/param', () => {
    const src = WEB_SEARCH_TOOL.scaffoldSource;
    expect(src).toContain('isMockMode');
    expect(src).toContain('api.search.brave.com/res/v1/web/search');
    expect(src).toContain("'X-Subscription-Token'");
    expect(src).toContain("set('q', query)"); // Brave's q param (not 'query')
    expect(src).toContain('data.web?.results'); // maps the documented shape
    // The mock branch returns BEFORE any fetch — assert the mock guard
    // precedes the fetch call in source order.
    expect(src.indexOf('isMockMode')).toBeLessThan(src.indexOf('fetch('));
  });

  it('engine-side call in mock mode is deterministic + does NO real fetch', async () => {
    const out = (await callTool({
      name: 'web_search',
      input: { query: 'climate' },
      mode: 'mock',
    })) as { results: Array<{ title: string; url: string; snippet: string }> };
    expect(Array.isArray(out.results)).toBe(true);
    expect(out.results.length).toBeGreaterThan(0);
    // Determinism.
    const again = (await callTool({
      name: 'web_search',
      input: { query: 'climate' },
      mode: 'mock',
    })) as unknown;
    expect(JSON.stringify(again)).toBe(JSON.stringify(out));
  });

  it('examples parse against the schemas', () => {
    for (const ex of WEB_SEARCH_TOOL.examples) {
      expect(WEB_SEARCH_TOOL.input_schema.safeParse(ex.input).success).toBe(true);
      expect(WEB_SEARCH_TOOL.output_schema.safeParse(ex.output).success).toBe(true);
    }
  });
});

// ===========================================================================
// RESOLVER
// ===========================================================================
describe('requiredProviderConnections', () => {
  it('a build selecting web_search requires the brave_search connection', () => {
    const required = requiredProviderConnections(['web_search', 'compute_math']);
    expect(required).toHaveLength(1);
    expect(required[0]!.provider).toBe('brave_search');
    expect(required[0]!.env_key).toBe('BRAVE_SEARCH_API_KEY');
  });

  it('an internal-only build requires NO provider connections', () => {
    expect(
      requiredProviderConnections(['compute_math', 'parse_json', 'parse_url']),
    ).toEqual([]);
  });

  it('dedupes by provider + skips unknown tool names', () => {
    const required = requiredProviderConnections([
      'web_search',
      'web_search',
      'does_not_exist',
    ]);
    expect(required).toHaveLength(1);
  });
});

// ===========================================================================
// DEPLOY GATE
// ===========================================================================
describe('buildProviderConnectionEnv — deploy gate', () => {
  it('MISSING key → NeedsConnectionError naming provider + env_key + setup_url; no env produced', async () => {
    try {
      await buildProviderConnectionEnv({
        toolNames: ['web_search'],
        lookupKey: async () => null, // not connected
      });
      expect.fail('expected NeedsConnectionError');
    } catch (err) {
      expect(err).toBeInstanceOf(NeedsConnectionError);
      const e = err as NeedsConnectionError;
      expect(e.provider).toBe('brave_search');
      expect(e.env_key).toBe('BRAVE_SEARCH_API_KEY');
      expect(e.setup_url).toBe('https://api-dashboard.search.brave.com/');
    }
  });

  it('PRESENT key → SERVER-ONLY env var (secret:true, NOT NEXT_PUBLIC)', async () => {
    const env = await buildProviderConnectionEnv({
      toolNames: ['web_search'],
      lookupKey: async (provider) =>
        provider === 'brave_search' ? 'bsk-test-resolved-value' : null,
    });
    expect(env).toHaveLength(1);
    expect(env[0]!.key).toBe('BRAVE_SEARCH_API_KEY');
    expect(env[0]!.value).toBe('bsk-test-resolved-value');
    expect(env[0]!.secret).toBe(true); // SERVER-ONLY
    expect(env[0]!.key.startsWith('NEXT_PUBLIC_')).toBe(false);
  });

  it('an internal-only build produces no provider env + never calls lookupKey', async () => {
    let lookups = 0;
    const env = await buildProviderConnectionEnv({
      toolNames: ['compute_math', 'parse_url'],
      lookupKey: async () => {
        lookups++;
        return 'should-not-be-called';
      },
    });
    expect(env).toEqual([]);
    expect(lookups).toBe(0);
  });
});

// ===========================================================================
// CLASSIFICATION
// ===========================================================================
describe('NeedsConnectionError classification', () => {
  it('classifies as the `auth` category', () => {
    const err = new NeedsConnectionError({
      provider: 'brave_search',
      label: 'Brave Search',
      env_key: 'BRAVE_SEARCH_API_KEY',
      setup_url: 'https://api-dashboard.search.brave.com/',
    });
    const classified = classifyError(err);
    expect(classified.category).toBe('auth');
    expect(classified.code).toBe('needs_connection_brave_search');
    expect(typeof classified.userMessage).toBe('string');
  });
});
