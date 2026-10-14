import { tokenizeSyntax } from './syntax';

export default function HighlightedCode({ source, language, inline = false, className }: { source: string; language?: string; inline?: boolean; className?: string }) {
  const tokens = tokenizeSyntax(source, language);
  const code = <code className={className}>{tokens.map((token, index) => <span key={index} className={`syntax-${token.kind}`}>{token.text}</span>)}</code>;
  return inline ? code : <pre className="syntax-block">{code}</pre>;
}

