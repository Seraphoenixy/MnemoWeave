import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createSRPClient, createSRPServer } from '@swan-io/srp'
import {
  SYNC_AUTH_VERSION, SYNC_PASSWORD_ITERATIONS, SYNC_SRP_GROUP, SYNC_SRP_HASH,
  syncSessionToken, validateSyncPassword, type SyncAuthRecord,
} from '../auth-protocol.ts'

const CHALLENGE_TTL = 60_000
const CHALLENGES_PER_MINUTE = 60
const SESSION_TTL = 30 * 60_000
const MAX_SESSIONS = 256
const digest = (token: string) => createHash('sha256').update(token).digest('hex')

interface PendingChallenge {
  expiresAt: number
  clientPublic: string
  serverSecret: string
}

export async function createSyncAuthRecord(password: string): Promise<SyncAuthRecord> {
  validateSyncPassword(password)
  const srp = createSRPClient(SYNC_SRP_HASH, SYNC_SRP_GROUP)
  const salt = srp.generateSalt()
  const privateKey = await srp.deriveSafePrivateKey(salt, password, SYNC_PASSWORD_ITERATIONS)
  return { version: SYNC_AUTH_VERSION, salt, verifier: srp.deriveVerifier(privateKey) }
}

/** A verifier for one installation. Proofs and sessions are scoped to this process. */
export class SyncAuthentication {
  private readonly srp = createSRPServer(SYNC_SRP_HASH, SYNC_SRP_GROUP)
  private readonly challenges = new Map<string, PendingChallenge>()
  private readonly sessions = new Map<string, number>()
  private readonly issued: number[] = []

  constructor(private readonly record: SyncAuthRecord, private readonly now = () => performance.now()) {}

  async challenge(clientPublic: string) {
    const now = this.now()
    while (this.issued[0] !== undefined && this.issued[0] <= now - CHALLENGE_TTL) this.issued.shift()
    if (this.issued.length >= CHALLENGES_PER_MINUTE) return undefined
    this.issued.push(now)
    for (const [id, challenge] of this.challenges) {
      if (challenge.expiresAt <= now) this.challenges.delete(id)
    }
    const ephemeral = await this.srp.generateEphemeral(this.record.verifier)
    const challengeId = randomUUID()
    this.challenges.set(challengeId, { expiresAt: now + CHALLENGE_TTL, clientPublic, serverSecret: ephemeral.secret })
    return { version: SYNC_AUTH_VERSION, challengeId, salt: this.record.salt, serverPublic: ephemeral.public }
  }

  async verify(challengeId: string, clientProof: string) {
    const challenge = this.challenges.get(challengeId)
    this.challenges.delete(challengeId)
    if (challenge === undefined || challenge.expiresAt <= this.now()) return undefined
    let serverProof: string
    try {
      const session = await this.srp.deriveSession(
        challenge.serverSecret, challenge.clientPublic, this.record.salt, '', this.record.verifier, clientProof,
      )
      serverProof = session.proof
    } catch {
      return undefined
    }
    const now = this.now()
    for (const [key, expiresAt] of this.sessions) {
      if (expiresAt <= now) this.sessions.delete(key)
    }
    const oldest = this.sessions.keys().next().value
    if (this.sessions.size >= MAX_SESSIONS && oldest !== undefined) this.sessions.delete(oldest)
    const token = randomBytes(32).toString('hex')
    this.sessions.set(digest(token), now + SESSION_TTL)
    return { serverProof, token }
  }

  authorized(authorization: string | undefined): boolean {
    if (!authorization?.startsWith('Bearer ')) return false
    const parsed = syncSessionToken.safeParse(authorization.slice(7))
    if (!parsed.success) return false
    const key = digest(parsed.data)
    const expiresAt = this.sessions.get(key)
    if (expiresAt === undefined) return false
    if (expiresAt > this.now()) return true
    this.sessions.delete(key)
    return false
  }
}
