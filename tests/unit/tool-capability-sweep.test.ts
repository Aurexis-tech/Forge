// Capability-honesty sweep — static-shape regression guard.
//
// Every tool registered in the engine MUST declare its capabilities
// honestly. After the contract migration the sweep scans BOTH:
//   - the engine-side `runtime` body (via .toString()), AND
//   - the `scaffoldSource` string shipped into generated agents.
//
// Rules enforced (under-declaration only — over-declaring a
// capability is allowed, e.g. a stubbed email tool that WILL read
// the network once implemented):
//   - If either source references a network primitive (fetch, http
//     URL, node:http(s), undici, XMLHttpRequest) → reads_network
//     MUST be true.
//   - If either source references an fs WRITE primitive (writeFile,
//     appendFile, createWriteStream, unlink) → writes_external MUST
//     be true.
//
// `destructive` is a judgement call with no reliable structural
// tell, so it is not swept.
//
// Same regression-guard pattern as
// tests/unit/audit-engine-error-sweep.test.ts.

import { describe, expect, it } from 'vitest';
import { listTools } from '@/lib/engine/tools';

const NETWORK_INDICATORS: ReadonlyArray<RegExp> = [
  /\bfetch\s*\(/,
  /https?:\/\//i,
  /from\s+['"]node:https?['"]/,
  /from\s+['"]undici['"]/,
  /\bXMLHttpRequest\b/,
];

const WRITE_INDICATORS: ReadonlyArray<RegExp> = [
  /\bwriteFile\s*\(/,
  /\bappendFile\s*\(/,
  /\bcreateWriteStream\s*\(/,
  /\bunlink\s*\(/,
];

function hasAny(src: string, indicators: ReadonlyArray<RegExp>): boolean {
  return indicators.some((re) => re.test(src));
}

/** The full static surface scanned for a tool: engine runtime + shipped source. */
function scannedSource(t: { runtime: unknown; scaffoldSource: string }): string {
  const runtimeSrc =
    typeof t.runtime === 'function' ? (t.runtime as () => unknown).toString() : '';
  return runtimeSrc + '\n' + t.scaffoldSource;
}

describe('capability sweep — runtime + scaffoldSource match declared capabilities', () => {
  it('every tool whose runtime OR scaffoldSource references network primitives declares reads_network:true', () => {
    for (const t of listTools()) {
      if (hasAny(scannedSource(t), NETWORK_INDICATORS)) {
        expect(
          t.capabilities.reads_network,
          'tool ' +
            t.name +
            ' references a network primitive but declares reads_network:false',
        ).toBe(true);
      }
    }
  });

  it('every tool whose runtime OR scaffoldSource references fs WRITE primitives declares writes_external:true', () => {
    for (const t of listTools()) {
      if (hasAny(scannedSource(t), WRITE_INDICATORS)) {
        expect(
          t.capabilities.writes_external,
          'tool ' +
            t.name +
            ' references an fs write primitive but declares writes_external:false',
        ).toBe(true);
      }
    }
  });

  // Positive coverage — the sweep DOES catch the network-touching
  // builtin tools via their scaffoldSource (whose fetch() the
  // engine-side runtime stub does not contain).
  it('web_search + http_request scaffoldSource trip the network indicator and are declared honestly', () => {
    for (const name of ['web_search', 'http_request']) {
      const t = listTools().find((x) => x.name === name)!;
      expect(hasAny(t.scaffoldSource, NETWORK_INDICATORS)).toBe(true);
      expect(t.capabilities.reads_network).toBe(true);
    }
  });

  it('file_write scaffoldSource trips the write indicator and declares writes_external:true', () => {
    const t = listTools().find((x) => x.name === 'file_write')!;
    expect(hasAny(t.scaffoldSource, WRITE_INDICATORS)).toBe(true);
    expect(t.capabilities.writes_external).toBe(true);
  });

  // Defence-in-depth: every seed tool (batch 1 + batch 2) declares
  // every capability false — and their scaffoldSource genuinely
  // contains no network/write tells.
  it('all six seed tools declare every capability false AND their scaffoldSource has no network/write tells', () => {
    const seeds = [
      'compute_math',
      'parse_json',
      'compute_text_transform',
      'compute_regex_extract',
      'parse_url',
      'parse_csv',
    ];
    for (const name of seeds) {
      const t = listTools().find((x) => x.name === name)!;
      expect(t, name + ' registered').toBeDefined();
      expect(t.capabilities.reads_network).toBe(false);
      expect(t.capabilities.writes_external).toBe(false);
      expect(t.capabilities.destructive).toBe(false);
      expect(hasAny(t.scaffoldSource, NETWORK_INDICATORS), name + ' scaffold network').toBe(false);
      expect(hasAny(t.scaffoldSource, WRITE_INDICATORS), name + ' scaffold write').toBe(false);
    }
  });
});
