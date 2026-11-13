import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import * as srp from 'secure-remote-password/server.js';
import { z } from 'zod';
import { MnemoWeaveError } from '../../../packages/core/contracts/src/index.ts';
import type { SyncStore } from '../../../packages/infrastructure/sync-store/src/index.ts';

const TTL = 300_000;
const MAX_PENDING = 1024;
const WINDOW_MS = 30_000;
const MAX_CHALLENGES_PER_WINDOW = 10;
const label = z.string().trim().min(1).max(200);
const salt = z.string().regex(/^[0-9a-f]{64}$/);
const publicValue = z.string().regex(/^[0-9a-f]{512}$/).refine(value => !/^0{511}[01]$/.test(value));
const randomToken = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest();

export function createEnrollment(store: SyncStore, bootstrapToken: string | undefined) {
  if (bootstrapToken !== undefined && bootstrapToken.length < 32) throw new Error('Invalid enrollment bootstrap token');
  const challenges = new Map<string, { secret: string; publicValue: string; source: string; expiresAt: number }>();
  const pairing = new Map<string, { issuer: string; expiresAt: number }>();
  const issuance = new Map<string, { count: number; expiresAt: number }>();
  const take = <T extends { expiresAt: number }>(map: Map<string, T>, key: string): T | undefined => {
    const value = map.get(key);
    map.delete(key);
    return value && value.expiresAt > Date.now() ? value : undefined;
  };
  const reserve = <T extends { expiresAt: number }>(map: Map<string, T>) => {
    for (const [key, item] of map) if (item.expiresAt <= Date.now()) map.delete(key);
    if (map.size >= MAX_PENDING) throw new MnemoWeaveError('UNAUTHORIZED');
  };
  const issue = (deviceLabel: string) => {
    const credential = { deviceId: randomUUID(), deviceToken: randomToken() };
    store.enroll(credential.deviceId, credential.deviceToken, deviceLabel);
    return credential;
  };
  return async (method: string | undefined, path: string, token: () => string, read: () => Promise<unknown>, source: string) => {
    if (method === 'GET' && path === '/v1/sync/auth/config') {
      const registration = store.authRegistration();
      return {
        initialized: !!registration, protocolVersion: 'srp6a-v1', kdfVersion: 'pbkdf2-sha256-v1',
        pbkdf2Iterations: 600_000, accessSalt: registration?.accessSalt, srpSalt: registration?.srpSalt,
      };
    }
    if (method !== 'POST') return undefined;
    if (path === '/v1/sync/devices/initialize') {
      if (!bootstrapToken || !timingSafeEqual(digest(token()), digest(bootstrapToken))) throw new MnemoWeaveError('UNAUTHORIZED');
      const { label: deviceLabel, ...registration } = z.object({
        label, accessSalt: z.string().regex(/^[A-Za-z0-9_-]{22}$/), srpSalt: salt, verifier: publicValue,
      }).strict().parse(await read());
      const credential = { deviceId: randomUUID(), deviceToken: randomToken() };
      store.initializeAuth(registration, credential.deviceId, credential.deviceToken, deviceLabel);
      return credential;
    }
    if (path === '/v1/sync/auth/login/challenge') {
      const input = z.object({ clientPublicEphemeral: publicValue }).strict().parse(await read());
      const registration = store.authRegistration();
      if (!registration) throw new MnemoWeaveError('UNAUTHORIZED');
      reserve(challenges);
      const time = Date.now();
      let budget = issuance.get(source);
      if (!budget || budget.expiresAt <= time) {
        issuance.delete(source);
        reserve(issuance);
        budget = { count: 0, expiresAt: time + WINDOW_MS };
        issuance.set(source, budget);
      }
      if (budget.count >= MAX_CHALLENGES_PER_WINDOW
        || [...challenges.values()].filter(challenge => challenge.source === source).length >= MAX_CHALLENGES_PER_WINDOW) {
        throw new MnemoWeaveError('UNAUTHORIZED');
      }
      budget.count++;
      const ephemeral = srp.generateEphemeral(registration.verifier);
      const challengeId = randomToken();
      challenges.set(challengeId, { secret: ephemeral.secret, publicValue: input.clientPublicEphemeral, source, expiresAt: time + TTL });
      return { challengeId, srpSalt: registration.srpSalt, serverPublicEphemeral: ephemeral.public };
    }
    if (path === '/v1/sync/auth/login/verify') {
      const input = z.object({ challengeId: z.string().max(64), clientPublicEphemeral: publicValue, clientSessionProof: salt, label }).strict().parse(await read());
      if (challenges.get(input.challengeId)?.source !== source) throw new MnemoWeaveError('UNAUTHORIZED');
      const challenge = take(challenges, input.challengeId);
      const registration = store.authRegistration();
      let proof: string;
      try {
        if (!challenge || !registration || challenge.publicValue !== input.clientPublicEphemeral) throw new Error('Invalid challenge');
        proof = srp.deriveSession(challenge.secret, input.clientPublicEphemeral, registration.srpSalt, 'ygdria', registration.verifier, input.clientSessionProof).proof;
      } catch {
        throw new MnemoWeaveError('UNAUTHORIZED');
      }
      return { ...issue(input.label), serverSessionProof: proof };
    }
    if (path === '/v1/sync/devices/pairing-token') {
      const issuer = store.streams(token()).deviceId;
      reserve(pairing);
      const pairingToken = randomToken();
      const expiresAt = Date.now() + TTL;
      pairing.set(digest(pairingToken).toString('hex'), { issuer, expiresAt });
      return { pairingToken, expiresAt };
    }
    if (path === '/v1/sync/devices/pair') {
      const input = z.object({ pairingToken: z.string().max(64), label }).strict().parse(await read());
      const pending = take(pairing, digest(input.pairingToken).toString('hex'));
      if (!pending) throw new MnemoWeaveError('UNAUTHORIZED');
      store.requireActiveDevice(pending.issuer);
      return issue(input.label);
    }
    return undefined;
  };
}
