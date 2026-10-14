/**
 * Small, dependency-free syntax tokenizer for the desktop renderer.
 *
 * The renderer must work offline and must never turn model output into HTML.
 * Tokens are returned as plain text fragments and React is responsible for
 * escaping them. This intentionally favours predictable highlighting over a
 * complete parser; unknown languages fall back to one plain token.
 */
export interface SyntaxToken { kind: 'plain' | 'comment' | 'string' | 'number' | 'keyword' | 'literal' | 'operator' | 'punctuation'; text: string; }

const KEYWORDS: Record<string, Set<string>> = {
  javascript: new Set('as async await break case catch class const continue debugger default delete do else export extends finally for from function get if implements import in instanceof interface let new of package private protected public return set static super switch this throw try typeof undefined var void while with yield'.split(' ')),
  typescript: new Set('as async await break case catch class const continue debugger declare default delete do else export extends finally for from function if implements import in interface keyof let namespace new of private protected public readonly return satisfies set static super switch this throw try type typeof undefined var void while with yield'.split(' ')),
  python: new Set('and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield'.split(' ')),
  php: new Set('abstract and array as break callable case catch class const continue declare default die do echo else elseif empty extends final finally fn for foreach function global if implements include instanceof interface namespace new or private protected public readonly require return static switch throw trait try use var while xor yield'.split(' ')),
  sql: new Set('select from where and or not insert into update delete create alter drop table view index join inner left right full outer on as distinct group by order having limit offset union all values set null is like exists case when then else end asc desc'.split(' ')),
  bash: new Set('if then else elif fi for while in do done case esac function select time until coproc return export local readonly declare'.split(' ')),
  yaml: new Set('true false null yes no on off'.split(' ')),
  json: new Set('true false null'.split(' ')),
};
const ALIASES: Record<string, string> = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', sh: 'bash', shell: 'bash', yml: 'yaml', md: 'markdown', html: 'html', htm: 'html', css: 'css' };
const KNOWN = new Set([...Object.keys(KEYWORDS), 'html', 'css', 'diff', 'markdown', 'text', 'plaintext', 'plain']);

export function normalizeLanguage(language?: string): string {
  const value = (language ?? '').trim().toLowerCase().replace(/^language-/, '');
  return ALIASES[value] ?? value;
}

function isKnown(language: string) { return KNOWN.has(language); }

/** Tokenize a code block. Unknown languages intentionally remain plain text. */
export function tokenizeSyntax(source: string, language?: string): SyntaxToken[] {
  const lang = normalizeLanguage(language);
  if (!source || !isKnown(lang) || ['text', 'plaintext', 'plain', 'markdown'].includes(lang)) return source ? [{ kind: 'plain', text: source }] : [];
  const keywords = KEYWORDS[lang] ?? KEYWORDS.javascript;
  const out: SyntaxToken[] = [];
  const pattern = /\/\/[^\n]*|#[^\n]*|--[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$-]*\b|===|!==|=>|==|!=|<=|>=|&&|\|\||\+\+|--|\*\*|[+*/%!=<>?:.-]|[{}[\]();,]/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? cursor;
    if (index > cursor) out.push({ kind: 'plain', text: source.slice(cursor, index) });
    const text = match[0];
    let kind: SyntaxToken['kind'] = 'plain';
    if (/^(?:\/\/|#|--|\/\*)/.test(text)) kind = 'comment';
    else if (/^[`'\"]/.test(text)) kind = 'string';
    else if (/^\d/.test(text)) kind = 'number';
    else if (/^[A-Za-z_$]/.test(text)) kind = keywords.has(text.toLowerCase()) ? (['true', 'false', 'null', 'undefined', 'none', 'nil'].includes(text.toLowerCase()) ? 'literal' : 'keyword') : 'plain';
    else if (/^[+*/%!=<>?:.-]|^(?:===|!==|=>|==|!=|<=|>=|&&|\|\||\+\+|--|\*\*)/.test(text)) kind = 'operator';
    else if (/^[{}[\]();,]$/.test(text)) kind = 'punctuation';
    out.push({ kind, text }); cursor = index + text.length;
  }
  if (cursor < source.length) out.push({ kind: 'plain', text: source.slice(cursor) });
  return out;
}

