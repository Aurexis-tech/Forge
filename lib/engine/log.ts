// STRUCTURED LOGGER — engine-wide single-line JSON logging on
// stdout. Replaces ad-hoc `console.log` / `console.error` so
// production log streams are parseable by downstream tooling
// (the Forge timeline, log aggregators, on-call dashboards).
//
// FORMAT
//   Every emission is ONE JSON object per line, with at least:
//     { timestamp, level, message }
//   Plus the optional fields scope, ref, category, plus any fields
//   the caller threaded via the `fields?` argument.
//
// LEVELS
//   silent < error < warn < info < debug.
//   - 'silent' emits NOTHING (tests + CI default).
//   - 'error'  emits error only.
//   - 'warn'   emits error + warn.
//   - 'info'   emits error + warn + info (production default).
//   - 'debug'  emits everything (local dev).
//   Controlled by `LOG_LEVEL` env. Tests set it to 'silent' in
//   tests/setup.ts to keep the existing suite quiet.
//
// SCOPES
//   engineLog('codegen') returns a logger whose every emission
//   carries `scope: 'codegen'`. Pass nothing for the default
//   unscoped logger.
//
// SAFETY
//   - JSON.stringify is wrapped — circular refs degrade to a
//     short marker rather than throwing.
//   - The logger NEVER throws from a logging call site — if
//     stringify fails it falls back to a plain string message.
//   - Writes go to process.stdout for info/debug and to
//     process.stderr for warn/error so production log routing
//     can split them.

export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

function currentLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').trim().toLowerCase();
  if ((LOG_LEVELS as readonly string[]).includes(raw)) {
    return raw as LogLevel;
  }
  return 'info';
}

export interface LogFields {
  /** Optional engine scope (e.g. 'codegen', 'sandbox', 'retry'). */
  scope?: string;
  /** Engine error category when applicable (transient_provider, etc.). */
  category?: string;
  /** Cost-ledger or governance ref the event correlates with. */
  ref?: string;
  /** Anything else. Stringified via JSON.stringify. */
  [key: string]: unknown;
}

/** Public logger surface. */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

// ===========================================================================
// EMISSION
// ===========================================================================

function shouldEmit(level: Exclude<LogLevel, 'silent'>): boolean {
  return LEVEL_RANK[currentLevel()] >= LEVEL_RANK[level];
}

function emit(
  level: Exclude<LogLevel, 'silent'>,
  baseFields: LogFields,
  message: string,
  fields?: LogFields,
): void {
  if (!shouldEmit(level)) return;
  const payload: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    ...baseFields,
    ...(fields ?? {}),
    message,
  };
  let line: string;
  try {
    line = JSON.stringify(payload, replacer);
  } catch {
    // Last-resort fallback — never throw from a log call.
    line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message: '[forge.log] failed to serialise log payload: ' + message,
    });
  }
  // Stream split: stdout for info/debug, stderr for warn/error.
  // Lets production log routing fan them out.
  const stream = level === 'warn' || level === 'error'
    ? process.stderr
    : process.stdout;
  // newline-delimited JSON, one object per line.
  stream.write(line + '\n');
}

/** JSON replacer that degrades non-serialisable values rather than throwing. */
function replacer(this: unknown, _key: string, value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  return value;
}

// ===========================================================================
// PUBLIC API
// ===========================================================================

/** The default unscoped logger. */
export const log: Logger = makeLogger({});

/**
 * Build a scoped logger that prefixes every emission with
 * `scope: <scope>`. Use one per engine module for grep-friendly
 * production logs.
 */
export function engineLog(scope: string): Logger {
  return makeLogger({ scope });
}

function makeLogger(baseFields: LogFields): Logger {
  return {
    debug(message, fields) {
      emit('debug', baseFields, message, fields);
    },
    info(message, fields) {
      emit('info', baseFields, message, fields);
    },
    warn(message, fields) {
      emit('warn', baseFields, message, fields);
    },
    error(message, fields) {
      emit('error', baseFields, message, fields);
    },
  };
}
