import { randomBytes, pbkdf2 } from 'node:crypto';
import { promisify } from 'node:util';
import * as srp from 'secure-remote-password/client.js';
import { z } from 'zod';
import { MnemoWeaveError } from '../../../core/contracts/src/index.ts';
import { SyncClient, syncBaseUrl } from './index.ts';

const derive = promisify(pbkdf2);
const credentialSchema = z.object({ deviceId: z.uuid(), deviceToken: z.string().min(32) });

export async function acquireSyncCredential(options: {
  baseUrl: string;
  label: string;
  mode: 'initialize' | 'login' | 'pair';
  secret: string;
  bootstrapToken?: string;
}) {
  const baseUrl = syncBaseUrl(options.baseUrl);
  const request = async (path: string, body?: unknown, token?: string): Promise<unknown> => {
    const response = await fetch(baseUrl + '/v1/sync' + path, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error('Sync enrollment failed (HTTP ' + response.status + ')');
    return response.json();
  };
  let credential: z.infer<typeof credentialSchema>;
  if (options.mode === 'pair') {
    credential = credentialSchema.parse(await request('/devices/pair', { label: options.label, pairingToken: options.secret }));
  } else {
    const config = z.object({
      initialized: z.boolean(), protocolVersion: z.literal('srp6a-v1'),
      kdfVersion: z.literal('pbkdf2-sha256-v1'), pbkdf2Iterations: z.literal(600_000),
      accessSalt: z.string().optional(), srpSalt: z.string().optional(),
    }).parse(await request('/auth/config'));
    const initializing = options.mode === 'initialize';
    if (config.initialized === initializing) throw new MnemoWeaveError('INVALID_INPUT');
    if (options.secret.length < 8 || options.secret.length > 64) throw new MnemoWeaveError('INVALID_INPUT');
    const accessSalt = initializing ? randomBytes(16).toString('base64url') : config.accessSalt;
    if (!accessSalt) throw new MnemoWeaveError('PROVIDER_PROTOCOL');
    const secret = (await derive(options.secret + 'ygdria/v1/access-secret', Buffer.from(accessSalt, 'base64url'), 600_000, 32, 'sha256')).toString('base64url');
    if (initializing) {
      const srpSalt = srp.generateSalt();
      const verifier = srp.deriveVerifier(srp.derivePrivateKey(srpSalt, 'ygdria', secret));
      credential = credentialSchema.parse(await request('/devices/initialize', { label: options.label, accessSalt, srpSalt, verifier }, options.bootstrapToken));
    } else {
      const ephemeral = srp.generateEphemeral();
      const challenge = z.object({ challengeId: z.string(), srpSalt: z.string(), serverPublicEphemeral: z.string() })
        .parse(await request('/auth/login/challenge', { clientPublicEphemeral: ephemeral.public }));
      if (challenge.srpSalt !== config.srpSalt) throw new MnemoWeaveError('PROVIDER_PROTOCOL');
      const privateKey = srp.derivePrivateKey(challenge.srpSalt, 'ygdria', secret);
      const session = srp.deriveSession(ephemeral.secret, challenge.serverPublicEphemeral, challenge.srpSalt, 'ygdria', privateKey);
      const result = credentialSchema.extend({ serverSessionProof: z.string() }).parse(await request('/auth/login/verify', {
        label: options.label, challengeId: challenge.challengeId, clientPublicEphemeral: ephemeral.public, clientSessionProof: session.proof,
      }));
      srp.verifySession(ephemeral.public, session, result.serverSessionProof);
      credential = credentialSchema.parse(result);
    }
  }
  const client = new SyncClient({ baseUrl, deviceId: credential.deviceId, token: credential.deviceToken });
  const confirmed = await client.streams();
  if (confirmed.deviceId !== credential.deviceId) throw new MnemoWeaveError('PROVIDER_PROTOCOL');
  return { baseUrl, deviceId: credential.deviceId, token: credential.deviceToken };
}
