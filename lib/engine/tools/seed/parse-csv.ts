// SEED TOOL — `parse_csv`.
//
// Parse CSV text into rows using papaparse (small, well-maintained,
// no native bindings). Pure / local — no I/O, deterministic. Carries
// the papaparse dependency via scaffoldDependencies, re-exercising
// the scaffoldDependencies -> package.json merge with a real 2nd dep.
//
// header:true  -> rows: Array<Record<string,string>> + fields[]
// header:false -> rows: string[][]
// A genuinely malformed CSV (unterminated quote) returns a typed
// bad_input EngineError rather than a raw throw.

import Papa from 'papaparse';
import { z } from 'zod';
import { badInputError } from '../../errors';
import type { ToolContext, ToolDefinition } from '../contract';

const inputSchema = z.object({
  csv: z.string(),
  header: z.boolean().optional(),
});
type Input = z.infer<typeof inputSchema>;

const outputSchema = z.object({
  rows: z.union([
    z.array(z.record(z.string())),
    z.array(z.array(z.string())),
  ]),
  fields: z.array(z.string()).optional(),
});
type Output = z.infer<typeof outputSchema>;

// papaparse error codes that mean the CSV is genuinely broken (as
// opposed to merely ragged, which we tolerate).
const FATAL_CODES = new Set(['MissingQuotes', 'InvalidQuotes']);

async function parseCsv(input: Input, _ctx: ToolContext): Promise<Output> {
  const header = input.header ?? false;
  const result = Papa.parse(input.csv, { header, skipEmptyLines: true });

  const fatal = (result.errors ?? []).find((e) => FATAL_CODES.has(e.code ?? ''));
  if (fatal) {
    throw badInputError(
      'csv_malformed',
      'CSV parse error (' + fatal.code + '): ' + fatal.message,
      'The CSV is malformed (e.g. an unterminated quoted field).',
    );
  }

  if (header) {
    const rows = (result.data as Array<Record<string, unknown>>).map(coerceRecord);
    return { rows, fields: result.meta.fields ?? [] };
  }
  const rows = (result.data as unknown[][]).map((row) =>
    row.map((cell) => (typeof cell === 'string' ? cell : String(cell ?? ''))),
  );
  return { rows };
}

function coerceRecord(r: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) {
    out[k] = typeof v === 'string' ? v : Array.isArray(v) ? v.join(',') : String(v ?? '');
  }
  return out;
}

const SCAFFOLD_SOURCE = `import Papa from 'papaparse';
import type { Tool } from './types.js';
import { isMockMode } from './types.js';

export interface ParseCsvInput {
  csv: string;
  header?: boolean;
}
export interface ParseCsvOutput {
  rows: Array<Record<string, string>> | string[][];
  fields?: string[];
}

const FATAL_CODES = new Set(['MissingQuotes', 'InvalidQuotes']);

export const parse_csv: Tool<ParseCsvInput, ParseCsvOutput> = {
  id: 'parse_csv',
  description: 'Parse CSV text into rows (papaparse).',
  async call({ csv, header }, ctx) {
    if (isMockMode(ctx)) {
      ctx.log('parse_csv.mock', { bytes: csv.length });
    }
    const useHeader = header ?? false;
    const result = Papa.parse(csv, { header: useHeader, skipEmptyLines: true });
    const fatal = (result.errors ?? []).find((e) => FATAL_CODES.has(e.code ?? ''));
    if (fatal) {
      throw new Error('[forge-agent] parse_csv: malformed CSV (' + fatal.code + ')');
    }
    if (useHeader) {
      const rows = (result.data as Array<Record<string, unknown>>).map((r) => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(r)) {
          out[k] = typeof v === 'string' ? v : Array.isArray(v) ? v.join(',') : String(v ?? '');
        }
        return out;
      });
      return { rows, fields: result.meta.fields ?? [] };
    }
    const rows = (result.data as unknown[][]).map((row) =>
      row.map((cell) => (typeof cell === 'string' ? cell : String(cell ?? ''))),
    );
    return { rows };
  },
};
`;

const SCAFFOLD_SIGNATURE =
  'export const parse_csv:      Tool<{ csv: string; header?: boolean }, { rows: Array<Record<string, string>> | string[][]; fields?: string[] }>;';

export const PARSE_CSV: ToolDefinition<Input, Output> = {
  name: 'parse_csv',
  description:
    'Parse CSV text into rows. With header:true returns objects keyed by column + the field ' +
    'list; with header:false returns string[][]. Use to ingest tabular data. Malformed CSV ' +
    '(unterminated quotes) returns an error.',
  category: 'parse',
  capabilities: {
    reads_network: false,
    writes_external: false,
    destructive: false,
  },
  input_schema: inputSchema,
  output_schema: outputSchema,
  runtime: parseCsv,
  mock: parseCsv,
  examples: [
    {
      label: 'with header',
      input: { csv: 'a,b\n1,2\n3,4', header: true },
      output: { rows: [{ a: '1', b: '2' }, { a: '3', b: '4' }], fields: ['a', 'b'] },
    },
    {
      label: 'without header',
      input: { csv: '1,2\n3,4' },
      output: { rows: [['1', '2'], ['3', '4']] },
    },
    {
      label: 'single record',
      input: { csv: 'name,age\nAda,36', header: true },
      output: { rows: [{ name: 'Ada', age: '36' }], fields: ['name', 'age'] },
    },
  ],
  scaffoldSource: SCAFFOLD_SOURCE,
  scaffoldInterfaceSignature: SCAFFOLD_SIGNATURE,
  scaffoldDependencies: { papaparse: '^5.5.3' },
  plannerLabel: 'CSV parser',
  envKeys: [],
  status: 'available',
};
