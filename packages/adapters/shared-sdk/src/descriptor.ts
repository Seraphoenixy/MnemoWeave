/** Adapter capability declaration (see docs/host-acceptance.md). */

export type CapabilityKey =
  | 'tool_calls' | 'session_start' | 'message_events' | 'tool_results'
  | 'context_injection' | 'dynamic_increment' | 'budget_reporting';

export type CapabilityStatus = 'supported' | 'unsupported' | 'unverified';

export interface AdapterCapability { status: CapabilityStatus; evidence: string; verifiedAt: string | null }

export interface AdapterDescriptor {
  hostProduct: 'DSH' | 'ChatGPT' | 'ZCode';
  hostVersion: string;
  adapterVersion: string;
  capabilities: Record<CapabilityKey, AdapterCapability>;
  /** HOST-02 first-version gate: automatic injection plus required event collection. */
  gatesMet: boolean;
}

const REQUIRED: readonly CapabilityKey[] = ['tool_calls', 'session_start', 'message_events', 'tool_results', 'context_injection', 'dynamic_increment', 'budget_reporting'];

/**
 * Every declared capability carries its status and evidence; `supported` requires a
 * verification date. Adapters must not claim collection or injection they cannot prove
 * (docs/host-acceptance.md) — unverified defaults keep that honest.
 */
export function unverifiedDescriptor(hostProduct: AdapterDescriptor['hostProduct'], hostVersion: string, adapterVersion: string, evidenceLink: string, verifiedAt: string | null = null): AdapterDescriptor {
  const capabilities = Object.fromEntries(REQUIRED.map(key => [key, { status: 'unverified', evidence: evidenceLink, verifiedAt }])) as Record<CapabilityKey, AdapterCapability>;
  return { hostProduct, hostVersion, adapterVersion, capabilities, gatesMet: false };
}

export function validateDescriptor(descriptor: AdapterDescriptor): void {
  if (!descriptor.hostVersion.trim() || !descriptor.adapterVersion.trim()) throw new Error('Adapter descriptor requires host and adapter versions');
  for (const key of REQUIRED) {
    const capability = descriptor.capabilities[key];
    if (!capability) throw new Error(`Missing capability declaration: ${key}`);
    if (capability.status === 'supported' && !capability.verifiedAt) throw new Error(`Capability '${key}' claims supported without a verification date`);
    if (!capability.evidence.trim()) throw new Error(`Capability '${key}' requires evidence`);
  }
  // The two non-negotiable first-version gates (HOST-02): without these the host blocks.
  const gates: CapabilityKey[] = ['context_injection', 'message_events', 'tool_results', 'session_start'];
  descriptor.gatesMet = gates.every(key => descriptor.capabilities[key].status === 'supported');
}
