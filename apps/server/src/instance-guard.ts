/**
 * Single-instance guard for the local Server.
 *
 * The scheduled task already guarantees one Server through `IgnoreNew`, so this covers the
 * paths around it: a manual start, a task racing a manual start, or a stale process from an
 * earlier run. Ask the port who holds it and only take it when nobody does.
 *
 * The distinction matters for the operator:
 *   - `ours`    → another MnemoWeave is already serving; exiting keeps the working one.
 *   - `foreign` → some other program owns the port; that is a real failure to surface.
 *   - `free`    → nothing is listening; this process may bind.
 */
export type PortOccupant = 'ours' | 'foreign' | 'free';

/** The identity field `/health/live` reports; duplicated here to avoid importing HTTP into the entry. */
const SERVICE = 'mnemoweave';

export async function inspectPort(input: {
  port: number;
  token: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}): Promise<PortOccupant> {
  // Port 0 asks the OS for any free port, so nothing can be occupying it and there is nothing
  // to probe. Treating it as a real port made every `MNEMOWEAVE_PORT=0` start (tests, ephemeral
  // servers) look like a conflict with another program.
  if (input.port === 0) return 'free';
  const doFetch = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 1_500;
  const url = `http://127.0.0.1:${input.port}/health/live`;
  try {
    const response = await doFetch(url, {
      headers: input.token === '' ? {} : { authorization: `Bearer ${input.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body: unknown = await response.json().catch(() => undefined);
    const service = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['service'] : undefined;
    // A 401 from our own Server still names it, so a token mismatch is "ours", not "foreign".
    return service === SERVICE ? 'ours' : 'foreign';
  } catch (error) {
    const code = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
    // Nothing accepted the connection: the port is free to take.
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') return 'free';
    // An address that accepts but never answers is not free; binding here would race it.
    return 'foreign';
  }
}
