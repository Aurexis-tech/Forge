// Renders tokenised code as styled spans. Pure function of (code, language).

import { pickLanguage, tokenize, type TokenKind } from './tokenize';

const TONE: Record<TokenKind, string> = {
  plain: 'text-forge-text/90',
  comment: 'text-forge-dim italic',
  string: 'text-forge-cyan',
  number: 'text-forge-amber',
  keyword: 'text-forge-amber font-medium',
  ident: 'text-forge-text/90',
};

export function HighlightedCode({
  path,
  content,
}: {
  path: string;
  content: string;
}) {
  const language = pickLanguage(path);
  const tokens = tokenize(content, language);

  return (
    <pre className="overflow-x-auto whitespace-pre font-mono text-xs leading-relaxed">
      <code>
        {tokens.map((t, i) => (
          <span key={i} className={TONE[t.kind]}>
            {t.text}
          </span>
        ))}
      </code>
    </pre>
  );
}
