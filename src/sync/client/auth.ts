import { createSRPClient } from '@swan-io/srp'
import {
  SYNC_AUTH_CHALLENGE, SYNC_AUTH_VERIFY, SYNC_PASSWORD_ITERATIONS, SYNC_SRP_GROUP, SYNC_SRP_HASH,
  syncChallengeResponse, syncVerifyResponse,
} from '../auth-protocol.ts'

export async function loginToSyncServer(base: URL, password: string, signal: AbortSignal | null): Promise<string> {
  const post = async (path: string, body: object): Promise<unknown> => {
    const url = new URL(base)
    url.pathname = base.pathname.replace(/\/+$/u, '') + path
    const response = await fetch(url, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error('Sync authentication returned HTTP ' + response.status)
    }
    return response.json()
  }

  const srp = createSRPClient(SYNC_SRP_HASH, SYNC_SRP_GROUP)
  const client = srp.generateEphemeral()
  const challenge = syncChallengeResponse.parse(await post(SYNC_AUTH_CHALLENGE, { clientPublic: client.public }))
  const privateKey = await srp.deriveSafePrivateKey(challenge.salt, password, SYNC_PASSWORD_ITERATIONS)
  const session = await srp.deriveSession(client.secret, challenge.serverPublic, challenge.salt, '', privateKey)
  const result = syncVerifyResponse.parse(await post(SYNC_AUTH_VERIFY, {
    challengeId: challenge.challengeId,
    clientProof: session.proof,
  }))
  await srp.verifySession(client.public, session, result.serverProof)
  return result.token
}
