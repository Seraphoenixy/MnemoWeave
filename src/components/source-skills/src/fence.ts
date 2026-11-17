/** The frontmatter fence alone, free of the YAML parser so the browser page can use it. */
export interface SplitSkill {
  /** Frontmatter text between the fences, verbatim. */
  frontmatter: string
  body: string
  /** Offsets into the original text, so an edit can keep everything else byte for byte. */
  frontmatterStart: number
  frontmatterEnd: number
}

/** The same fence rules as `dsh-skill-filesystem`: `---` on the first line and on a later line of its own. */
export function splitFrontmatter(raw: string): SplitSkill | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0 || raw.slice(0, firstLineEnd).replace(/\r$/u, '') !== '---') return undefined
  const start = firstLineEnd + 1
  let lineStart = start
  while (lineStart <= raw.length) {
    const next = raw.indexOf('\n', lineStart)
    const lineEnd = next < 0 ? raw.length : next
    if (raw.slice(lineStart, lineEnd).replace(/\r$/u, '') === '---') {
      return { frontmatter: raw.slice(start, lineStart), body: raw.slice(next < 0 ? raw.length : next + 1), frontmatterStart: start, frontmatterEnd: lineStart }
    }
    if (next < 0) return undefined
    lineStart = next + 1
  }
  return undefined
}
