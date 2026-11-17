/**
 * Read an Error or a serialized failure without dumping arbitrary request or
 * Provider data.
 *
 * `fetch` rejects with a bare `TypeError: fetch failed` and puts the real reason
 * — a refused connection, an expired certificate, a DNS failure — in `cause`.
 * Reporting only the message leaves a failure nobody can act on, so the cause
 * chain is followed and appended. Cycles and depth are bounded, because a
 * transport may nest causes arbitrarily.
 */
export function errorMessage(error: unknown, fallback = 'Operation failed without a readable error message.'): string {
  const text = describe(error)
  return text ?? fallback
}

const MAX_CAUSE_DEPTH = 4

function describe(value: unknown): string | undefined {
  const message = messageOf(value)
  const causes: string[] = []
  const seen = new Set<unknown>()
  let current = causeOf(value)
  for (let depth = 0; current !== undefined && depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (seen.has(current)) break
    seen.add(current)
    const cause = describeOnce(current)
    if (cause !== undefined && cause !== message) causes.push(cause)
    current = causeOf(current)
  }
  const parts = [message, ...causes].filter((part): part is string => part !== undefined && part !== '')
  return parts.length === 0 ? undefined : parts.join(' — ')
}

function messageOf(value: unknown): string | undefined {
  try {
    const message = typeof value === 'object' && value !== null ? ('message' in value ? value.message : undefined)
      : value === undefined || value === null ? undefined : String(value)
    if (typeof message !== 'string') return undefined
    const trimmed = message.trim()
    return trimmed === '' || /^(?:Error:\s*)?\[object Object\]$/u.test(trimmed) ? undefined : trimmed
  } catch { return undefined }
}

/** One cause, named with its own error code when it carries one. */
function describeOnce(value: unknown): string | undefined {
  const message = messageOf(value)
  const code = codeOf(value)
  if (message === undefined) return code
  return code === undefined || message.includes(code) ? message : `${message} (${code})`
}

function codeOf(value: unknown): string | undefined {
  try {
    if (typeof value !== 'object' || value === null || !('code' in value)) return undefined
    const code = (value as { code?: unknown }).code
    return typeof code === 'string' && code !== '' ? code : undefined
  } catch { return undefined }
}

function causeOf(value: unknown): unknown {
  try {
    if (typeof value !== 'object' || value === null || !('cause' in value)) return undefined
    return (value as { cause?: unknown }).cause
  } catch { return undefined }
}