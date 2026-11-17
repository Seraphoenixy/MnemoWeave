import { z } from 'zod'

export const SYNC_AUTH_VERSION = 'srp6a-v1'
export const SYNC_AUTH_CHALLENGE = '/v1/auth/login/challenge'
export const SYNC_AUTH_VERIFY = '/v1/auth/login/verify'
export const SYNC_SRP_HASH = 'SHA-256'
export const SYNC_SRP_GROUP = 3072
export const SYNC_PASSWORD_ITERATIONS = 600_000

const salt = z.string().regex(/^[a-f0-9]{64}$/u)
const publicValue = z.string().regex(/^[a-f0-9]{768}$/u)
const proof = z.string().regex(/^[a-f0-9]{64}$/u)
const challengeId = z.uuid()
export const syncSessionToken = z.string().regex(/^[a-f0-9]{64}$/u)

export const syncAuthRecord = z.strictObject({
  version: z.literal(SYNC_AUTH_VERSION),
  salt,
  verifier: publicValue,
})
export type SyncAuthRecord = z.infer<typeof syncAuthRecord>

export const syncChallengeRequest = z.strictObject({ clientPublic: publicValue })
export const syncChallengeResponse = z.strictObject({
  version: z.literal(SYNC_AUTH_VERSION),
  challengeId,
  salt,
  serverPublic: publicValue,
})
export const syncVerifyRequest = z.strictObject({ challengeId, clientProof: proof })
export const syncVerifyResponse = z.strictObject({ serverProof: proof, token: syncSessionToken })

export function validateSyncPassword(password: string): void {
  const length = Buffer.byteLength(password, 'utf8')
  if (length < 8 || length > 1024 || /[\0\r\n]/u.test(password)) {
    throw new Error('Sync password must be 8–1024 UTF-8 bytes on a single line')
  }
}
