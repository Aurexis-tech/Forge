// Cheap static check for generated files.
//
// SECURITY BOUNDARY — this module MUST NOT execute generated code. It only
// asks esbuild to parse + transpile a string. esbuild.transform() is purely a
// syntactic operation: no module resolution, no eval, no new Function, no
// import side-effects. Sandbox execution happens in the *next* layer.

import { transform, type Loader } from 'esbuild';

export type StaticCheckResult =
  | { ok: true }
  | { ok: false; error: string };

export async function staticCheckFile(
  path: string,
  content: string,
): Promise<StaticCheckResult> {
  if (path.endsWith('.json')) {
    return checkJson(content);
  }
  const loader = pickLoader(path);
  if (!loader) {
    // Markdown, plain text, etc — nothing to check.
    return { ok: true };
  }
  try {
    await transform(content, {
      loader,
      sourcefile: path,
      target: 'es2022',
      logLevel: 'silent',
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeEsbuildError(err) };
  }
}

function pickLoader(path: string): Loader | null {
  if (path.endsWith('.ts')) return 'ts';
  if (path.endsWith('.tsx')) return 'tsx';
  if (path.endsWith('.js')) return 'js';
  if (path.endsWith('.jsx')) return 'jsx';
  if (path.endsWith('.mjs') || path.endsWith('.cjs')) return 'js';
  return null;
}

function checkJson(content: string): StaticCheckResult {
  try {
    JSON.parse(content);
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'invalid JSON',
    };
  }
}

interface EsbuildLikeError {
  errors?: Array<{
    text?: string;
    location?: { line?: number; column?: number; file?: string } | null;
  }>;
  message?: string;
}

function describeEsbuildError(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'errors' in err) {
    const errors = (err as EsbuildLikeError).errors ?? [];
    if (errors.length > 0) {
      return errors
        .slice(0, 4)
        .map((e) => {
          const text = e.text ?? 'unknown error';
          const loc = e.location;
          if (loc && loc.line != null) {
            return (loc.file ?? '') + ':' + loc.line + ':' + (loc.column ?? 0) + ' ' + text;
          }
          return text;
        })
        .join('\n');
    }
  }
  return err instanceof Error ? err.message : 'unknown esbuild error';
}
