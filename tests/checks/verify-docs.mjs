// Check local links and Markdown anchors.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function withoutFences(markdown) {
  let fence
  return markdown.split('\n').map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1]
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence ? undefined : marker
      return ''
    }
    return fence ? '' : line
  }).join('\n')
}

function htmlEntities(text) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }
  return text.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/giu, (match, entity) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()]
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
  })
}

export function headingIds(markdown) {
  const text = withoutFences(markdown)
  const ids = new Set()
  for (const match of text.matchAll(/^ {0,3}#{1,6}\s+(.+)$|<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gimu)) {
    const base = htmlEntities((match[1] ?? match[2]).replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1').replace(/<[^>]*>/gu, ''))
      .replace(/\s+#+\s*$/u, '').trim().toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /gu, '-')
    let id = base
    let suffix = 0
    while (ids.has(id)) id = `${base}-${++suffix}`
    ids.add(id)
  }
  for (const match of text.matchAll(/\b(?:id|name)=["']([^"']+)["']/gu)) ids.add(match[1])
  return ids
}

export function documentLinks(markdown) {
  const text = withoutFences(markdown).replace(/`+[^`\n]*`+/gu, '')
  const links = []
  const patterns = [
    /\]\(\s*(?:<([^>]+)>|([^\s)]+))/gu,
    /^ {0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|([^\s]+))/gmu,
    /\b(?:href|src)=["']([^"']+)["']/gu,
    /<(https?:\/\/[^\s<>]+)>/gu,
  ]
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    links.push({ url: htmlEntities(match[1] ?? match[2]), line: text.slice(0, match.index).split('\n').length })
  }
  return links
}

export function checkDocuments(root, files) {
  const failures = []
  let localLinks = 0
  let anchors = 0
  const cachedIds = new Map()
  for (const file of files.filter(file => file.endsWith('.md'))) {
    const body = readFileSync(join(root, file), 'utf8')
    for (const { url, line } of documentLinks(body)) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(url)) continue
      const [pathAndQuery, rawAnchor] = url.split('#')
      const rawPath = pathAndQuery.split('?')[0]
      let target, anchor
      try {
        target = rawPath ? resolve(root, dirname(file), decodeURIComponent(rawPath)) : join(root, file)
        anchor = rawAnchor ? decodeURIComponent(rawAnchor) : undefined
      } catch { failures.push(`${file}:${line}: malformed link ${url}`); continue }
      localLinks++
      if (!existsSync(target)) { failures.push(`${file}:${line}: missing ${url}`); continue }
      if (anchor && target.endsWith('.md') && statSync(target).isFile()) {
        anchors++
        if (!cachedIds.has(target)) cachedIds.set(target, headingIds(readFileSync(target, 'utf8')))
        if (!cachedIds.get(target).has(anchor)) failures.push(`${file}:${line}: missing anchor ${url}`)
      }
    }
  }
  return { localLinks, anchors, failures }
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(file => file && existsSync(join(root, file))))]
  const report = checkDocuments(root, files)
  if (report.failures.length) {
    console.error(report.failures.join('\n'))
    process.exitCode = 1
  } else console.log(`Documentation verified: ${report.localLinks} local links and ${report.anchors} Markdown anchors.`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
