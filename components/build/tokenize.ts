// Tiny pure-function tokenizer for light syntax highlighting in the preview.
// Single-pass, regex-light, no execution. Good enough for TS/JS/JSON.

export type TokenKind =
  | 'plain'
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'ident';

export interface Token {
  kind: TokenKind;
  text: string;
}

const KEYWORDS = new Set([
  'abstract', 'any', 'as', 'async', 'await', 'boolean', 'break', 'case',
  'catch', 'class', 'const', 'continue', 'declare', 'default', 'do', 'else',
  'enum', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function',
  'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'is', 'let',
  'module', 'namespace', 'never', 'new', 'null', 'number', 'of', 'private',
  'protected', 'public', 'readonly', 'require', 'return', 'static', 'string',
  'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined',
  'var', 'void', 'while', 'yield',
]);

export type Language = 'ts' | 'json' | 'plain';

export function pickLanguage(path: string): Language {
  if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(path)) return 'ts';
  if (path.endsWith('.json')) return 'json';
  return 'plain';
}

export function tokenize(code: string, language: Language): Token[] {
  if (language === 'plain') return [{ kind: 'plain', text: code }];

  const tokens: Token[] = [];
  let buffer = '';
  let i = 0;

  function flush() {
    if (buffer) {
      tokens.push({ kind: 'plain', text: buffer });
      buffer = '';
    }
  }

  while (i < code.length) {
    const ch = code[i] ?? '';
    const next = code[i + 1] ?? '';

    // line comment
    if (ch === '/' && next === '/') {
      flush();
      const nl = code.indexOf('\n', i);
      const end = nl === -1 ? code.length : nl;
      tokens.push({ kind: 'comment', text: code.slice(i, end) });
      i = end;
      continue;
    }

    // block comment
    if (ch === '/' && next === '*') {
      flush();
      const closer = code.indexOf('*/', i + 2);
      const end = closer === -1 ? code.length : closer + 2;
      tokens.push({ kind: 'comment', text: code.slice(i, end) });
      i = end;
      continue;
    }

    // string (single, double, backtick — flat, no expression highlighting)
    if (ch === '"' || ch === "'" || ch === '`') {
      flush();
      const quote = ch;
      let j = i + 1;
      while (j < code.length) {
        const cj = code[j];
        if (cj === '\\') {
          j += 2;
          continue;
        }
        if (cj === quote) {
          j++;
          break;
        }
        j++;
      }
      tokens.push({ kind: 'string', text: code.slice(i, j) });
      i = j;
      continue;
    }

    // identifier / keyword
    if (isIdentStart(ch)) {
      flush();
      let j = i + 1;
      while (j < code.length && isIdentPart(code[j] ?? '')) j++;
      const word = code.slice(i, j);
      tokens.push({
        kind: KEYWORDS.has(word) ? 'keyword' : 'ident',
        text: word,
      });
      i = j;
      continue;
    }

    // number (must not be following an ident char)
    if (isDigit(ch) && !isIdentPart(code[i - 1] ?? '')) {
      flush();
      let j = i + 1;
      while (j < code.length && (isDigit(code[j] ?? '') || code[j] === '.')) {
        j++;
      }
      tokens.push({ kind: 'number', text: code.slice(i, j) });
      i = j;
      continue;
    }

    buffer += ch;
    i++;
  }

  flush();
  return tokens;
}

function isIdentStart(ch: string): boolean {
  return /[a-zA-Z_$]/.test(ch);
}
function isIdentPart(ch: string): boolean {
  return /[a-zA-Z0-9_$]/.test(ch);
}
function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}
