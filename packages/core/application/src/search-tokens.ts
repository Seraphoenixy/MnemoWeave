/**
 * Deterministic lexical fallback for recall.
 *
 * Ported from the upstream Memory Spaces Source. It is not a second search engine: when the
 * Provider's ranking returns nothing that covers the words the caller actually typed, these
 * tokens decide which recovered rows are allowed into the answer. Han text is split into
 * overlapping character pairs because Chinese has no word delimiter, and a two-character window is
 * the smallest unit that carries meaning.
 */
export function lexicalSearchTokens(value: string, maximum = 64): string[] {
  const normalized = value.normalize('NFKC').toLocaleLowerCase();
  const tokens: string[] = [];
  for (const segment of normalized.split(/(\p{Script=Han}+)/gu)) {
    if (/^\p{Script=Han}+$/u.test(segment)) {
      const characters = [...segment];
      if (characters.length <= 2) tokens.push(segment);
      else for (let index = 0; index < characters.length - 1; index += 1) tokens.push(`${characters[index]}${characters[index + 1]}`);
      continue;
    }
    tokens.push(...(segment.match(/[\p{L}\p{N}_-]+/gu) ?? []).filter(token => token.length >= 2));
  }
  return [...new Set(tokens)].slice(0, maximum);
}

export function lexicalTokenMatchCount(value: string, tokens: readonly string[]): number {
  const available = new Set(lexicalSearchTokens(value, 512));
  return tokens.filter(token => available.has(token)).length;
}

/** Require broader coverage only after a query is focused enough to support it. */
export function lexicalRequiredMatchCount(tokens: readonly string[]): number {
  if (tokens.length === 0) return 0;
  if (tokens.length < 4) return 1;
  return Math.max(2, Math.ceil(tokens.length / 4));
}
