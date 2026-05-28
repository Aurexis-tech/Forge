// Hermetic unit test — structured logger.
//
// Captures stdout + stderr writes via vi.spyOn so we can assert
// the exact JSON shape per level without touching real I/O. Tests
// restore LOG_LEVEL to 'silent' (the tests/setup default) after
// each case to keep the rest of the suite quiet.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { engineLog, log, LOG_LEVELS } from '@/lib/engine/log';

interface Capture {
  stdout: string[];
  stderr: string[];
  restore: () => void;
}

function captureStreams(): Capture {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(((chunk: string | Uint8Array) => {
      const s =
        typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      stdoutLines.push(s.replace(/\n$/, ''));
      return true;
    }) as typeof process.stdout.write);
  const stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(((chunk: string | Uint8Array) => {
      const s =
        typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      stderrLines.push(s.replace(/\n$/, ''));
      return true;
    }) as typeof process.stderr.write);
  return {
    stdout: stdoutLines,
    stderr: stderrLines,
    restore: () => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    },
  };
}

beforeEach(() => {
  // Each test sets its own LOG_LEVEL; default to suite-silent.
  process.env.LOG_LEVEL = 'silent';
});

afterEach(() => {
  process.env.LOG_LEVEL = 'silent';
});

// ===========================================================================
// PER-LEVEL EMISSION
// ===========================================================================
describe('engine logger — per-level shape', () => {
  it('info emits a structured JSON line on stdout', () => {
    process.env.LOG_LEVEL = 'info';
    const cap = captureStreams();
    log.info('hello', { ref: 'codegen.x' });
    cap.restore();
    expect(cap.stdout.length).toBe(1);
    const parsed = JSON.parse(cap.stdout[0]!);
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('hello');
    expect(parsed.ref).toBe('codegen.x');
    expect(typeof parsed.timestamp).toBe('string');
    // warn/error stream wasn't touched.
    expect(cap.stderr.length).toBe(0);
  });

  it('error emits on stderr (stream split)', () => {
    process.env.LOG_LEVEL = 'info';
    const cap = captureStreams();
    log.error('boom');
    cap.restore();
    expect(cap.stderr.length).toBe(1);
    const parsed = JSON.parse(cap.stderr[0]!);
    expect(parsed.level).toBe('error');
    expect(parsed.message).toBe('boom');
  });

  it('warn emits on stderr', () => {
    process.env.LOG_LEVEL = 'info';
    const cap = captureStreams();
    log.warn('careful');
    cap.restore();
    expect(cap.stderr.length).toBe(1);
    expect(JSON.parse(cap.stderr[0]!).level).toBe('warn');
  });

  it('debug emits on stdout when level=debug', () => {
    process.env.LOG_LEVEL = 'debug';
    const cap = captureStreams();
    log.debug('deep');
    cap.restore();
    expect(cap.stdout.length).toBe(1);
    expect(JSON.parse(cap.stdout[0]!).level).toBe('debug');
  });
});

// ===========================================================================
// LEVEL FILTERING
// ===========================================================================
describe('engine logger — LOG_LEVEL filtering', () => {
  it("LOG_LEVEL='silent' emits nothing across all levels", () => {
    process.env.LOG_LEVEL = 'silent';
    const cap = captureStreams();
    log.error('x');
    log.warn('x');
    log.info('x');
    log.debug('x');
    cap.restore();
    expect(cap.stdout.length).toBe(0);
    expect(cap.stderr.length).toBe(0);
  });

  it("LOG_LEVEL='error' emits error only", () => {
    process.env.LOG_LEVEL = 'error';
    const cap = captureStreams();
    log.error('e');
    log.warn('w');
    log.info('i');
    log.debug('d');
    cap.restore();
    expect(cap.stdout.length).toBe(0);
    expect(cap.stderr.length).toBe(1);
    expect(JSON.parse(cap.stderr[0]!).level).toBe('error');
  });

  it("LOG_LEVEL='warn' emits error + warn", () => {
    process.env.LOG_LEVEL = 'warn';
    const cap = captureStreams();
    log.error('e');
    log.warn('w');
    log.info('i');
    log.debug('d');
    cap.restore();
    expect(cap.stdout.length).toBe(0);
    expect(cap.stderr.length).toBe(2);
  });

  it("LOG_LEVEL='info' emits error + warn + info (default production)", () => {
    process.env.LOG_LEVEL = 'info';
    const cap = captureStreams();
    log.error('e');
    log.warn('w');
    log.info('i');
    log.debug('d');
    cap.restore();
    expect(cap.stdout.length).toBe(1); // info on stdout
    expect(cap.stderr.length).toBe(2); // warn + error on stderr
  });

  it('invalid LOG_LEVEL falls back to info', () => {
    process.env.LOG_LEVEL = 'garbage';
    const cap = captureStreams();
    log.info('still works');
    cap.restore();
    expect(cap.stdout.length).toBe(1);
  });

  it('LOG_LEVELS export is the canonical list', () => {
    expect(LOG_LEVELS).toEqual([
      'silent',
      'error',
      'warn',
      'info',
      'debug',
    ]);
  });
});

// ===========================================================================
// SCOPED LOGGER
// ===========================================================================
describe('engineLog(scope) — prefixes every emission', () => {
  it('every emission carries the scope key', () => {
    process.env.LOG_LEVEL = 'debug';
    const cap = captureStreams();
    const scoped = engineLog('codegen');
    scoped.info('a');
    scoped.warn('b');
    scoped.error('c');
    scoped.debug('d');
    cap.restore();
    const all = [...cap.stdout, ...cap.stderr].map((l) => JSON.parse(l));
    for (const obj of all) {
      expect(obj.scope).toBe('codegen');
    }
  });

  it('caller fields can override scope when explicitly passed', () => {
    process.env.LOG_LEVEL = 'info';
    const cap = captureStreams();
    const scoped = engineLog('codegen');
    scoped.info('x', { scope: 'override' });
    cap.restore();
    const parsed = JSON.parse(cap.stdout[0]!);
    expect(parsed.scope).toBe('override');
  });
});

// ===========================================================================
// SAFETY
// ===========================================================================
describe('engine logger — safety', () => {
  it('never throws when JSON.stringify hits a circular reference', () => {
    process.env.LOG_LEVEL = 'info';
    const cap = captureStreams();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => log.info('cyclic', { circular })).not.toThrow();
    cap.restore();
    // We don't assert the exact recovery shape — just that
    // SOMETHING landed without crashing.
    expect(cap.stdout.length).toBe(1);
  });

  it('serialises Error objects compactly (no stack noise)', () => {
    process.env.LOG_LEVEL = 'info';
    const cap = captureStreams();
    log.info('with error', { err: new Error('test') });
    cap.restore();
    const parsed = JSON.parse(cap.stdout[0]!);
    expect(parsed.err).toEqual({ name: 'Error', message: 'test' });
  });

  it('bigint serialises to string (JSON-safe)', () => {
    process.env.LOG_LEVEL = 'info';
    const cap = captureStreams();
    log.info('big', { n: BigInt(42) });
    cap.restore();
    const parsed = JSON.parse(cap.stdout[0]!);
    expect(parsed.n).toBe('42');
  });
});
