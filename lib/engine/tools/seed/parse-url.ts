// SEED TOOL — `parse_url`.
//
// Parse a URL into its components using the built-in WHATWG `URL`.
// Pure / local — no I/O, deterministic, zero-dep. An invalid URL
// returns a typed bad_input EngineError rather than a raw TypeError.

import { z } from 'zod';
import { badInputError } from '../../errors';
import type { ToolContext, ToolDefinition } from '../contract';

const inputSchema = z.object({
  url: z.string(),
});
type Input = z.infer<typeof inputSchema>;

const outputSchema = z.object({
  protocol: z.string(),
  host: z.string(),
  hostname: z.string(),
  port: z.string(),
  pathname: z.string(),
  search: z.string(),
  query: z.record(z.string()),
  hash: z.string(),
});
type Output = z.infer<typeof outputSchema>;

async function parseUrl(input: Input, _ctx: ToolContext): Promise<Output> {
  let u: URL;
  try {
    u = new URL(input.url);
  } catch {
    throw badInputError(
      'url_invalid',
      'not a valid absolute URL: ' + input.url.slice(0, 200),
      'That is not a valid URL. Provide an absolute URL that includes a scheme and host.',
    );
  }
  const query: Record<string, string> = {};
  u.searchParams.forEach((value, key) => {
    query[key] = value;
  });
  return {
    protocol: u.protocol,
    host: u.host,
    hostname: u.hostname,
    port: u.port,
    pathname: u.pathname,
    search: u.search,
    query,
    hash: u.hash,
  };
}

const SCAFFOLD_SOURCE = `import type { Tool } from './types.js';
import { isMockMode } from './types.js';

export interface ParseUrlInput {
  url: string;
}
export interface ParseUrlOutput {
  protocol: string;
  host: string;
  hostname: string;
  port: string;
  pathname: string;
  search: string;
  query: Record<string, string>;
  hash: string;
}

export const parse_url: Tool<ParseUrlInput, ParseUrlOutput> = {
  id: 'parse_url',
  description: 'Parse a URL into its components (built-in URL).',
  async call({ url }, ctx) {
    if (isMockMode(ctx)) {
      ctx.log('parse_url.mock', { url });
    }
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error('[forge-agent] parse_url: invalid URL');
    }
    const query: Record<string, string> = {};
    u.searchParams.forEach((value, key) => {
      query[key] = value;
    });
    return {
      protocol: u.protocol,
      host: u.host,
      hostname: u.hostname,
      port: u.port,
      pathname: u.pathname,
      search: u.search,
      query,
      hash: u.hash,
    };
  },
};
`;

const SCAFFOLD_SIGNATURE =
  'export const parse_url:      Tool<{ url: string }, { protocol: string; host: string; hostname: string; port: string; pathname: string; search: string; query: Record<string, string>; hash: string }>;';

export const PARSE_URL: ToolDefinition<Input, Output> = {
  name: 'parse_url',
  description:
    'Parse a URL into protocol, host, hostname, port, pathname, search, parsed query map, ' +
    'and hash. Use to inspect or route on URL parts. Invalid URLs return an error.',
  category: 'parse',
  capabilities: {
    reads_network: false,
    writes_external: false,
    destructive: false,
  },
  input_schema: inputSchema,
  output_schema: outputSchema,
  runtime: parseUrl,
  mock: parseUrl,
  examples: [
    {
      label: 'full URL with query + hash',
      input: { url: 'https://ex.com:8080/p/q?a=1&b=2#frag' },
      output: {
        protocol: 'https:',
        host: 'ex.com:8080',
        hostname: 'ex.com',
        port: '8080',
        pathname: '/p/q',
        search: '?a=1&b=2',
        query: { a: '1', b: '2' },
        hash: '#frag',
      },
    },
    {
      label: 'bare host',
      input: { url: 'http://localhost/' },
      output: {
        protocol: 'http:',
        host: 'localhost',
        hostname: 'localhost',
        port: '',
        pathname: '/',
        search: '',
        query: {},
        hash: '',
      },
    },
  ],
  scaffoldSource: SCAFFOLD_SOURCE,
  scaffoldInterfaceSignature: SCAFFOLD_SIGNATURE,
  plannerLabel: 'URL parser',
  envKeys: [],
  status: 'available',
};
