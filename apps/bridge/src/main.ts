import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
// Shared Bridge process entry (WP6/WP7 wiring): local-first reads for Host adapters,
// 30-second incremental sync (SYNC-04) and offline intent drainage against the Server.
import { bridgeFromEnv } from './http-channel.ts';
import { createInjectionServer } from './view-server.ts';
import { createUiServer } from './ui-server.ts';
import { InjectionSessions } from '../../../packages/bridge/src/injection.ts';
import type { ViewRecord } from '../../../packages/core/contracts/src/index.ts';
import { MnemoWeaveError } from '../../../packages/core/contracts/src/index.ts';

function createHost(env: NodeJS.ProcessEnv) {
  let bridge: ReturnType<typeof bridgeFromEnv>['bridge'] | undefined;
  try {
    const started = bridgeFromEnv(env);
    const activeBridge = started.bridge;
    bridge = activeBridge;
    const intervalMs = started.intervalMs;
    const logLine = (payload: Record<string, unknown>): string => `${JSON.stringify(payload)}\n`;
    const assembleRemote = async (input: { query: string | null; sessionId?: string; projectId?: string | undefined; task?: string | undefined; budgetTokens?: number | undefined; pinned?: ReadonlyArray<{ memoryId: string; tier: 'critical' | 'normal' }> | undefined }): Promise<ViewRecord> => {
      const body: Record<string, unknown> = {};
      for (const key of ['sessionId', 'projectId', 'task', 'budgetTokens'] as const) if (input[key] !== undefined) body[key] = input[key];
      if (input.query) body['query'] = input.query;
      if (input.pinned) body['pinned'] = input.pinned;
      const response = await fetch(`${started.serverUrl}/v1/view`, {
        method: 'POST',
        headers: { authorization: `Bearer ${started.token}`, 'x-mnemoweave-host': started.hostId, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(1_900),
      });
      if (!response.ok) throw new Error(`view assembly failed: HTTP ${response.status}`);
      return await response.json() as ViewRecord;
    };
    const assemble = async (input: { query: string | null; sessionId?: string; projectId?: string | undefined; task?: string | undefined; budgetTokens?: number | undefined; pinned?: ReadonlyArray<{ memoryId: string; tier: 'critical' | 'normal' }> | undefined }): Promise<ViewRecord> => {
      try { return await activeBridge.localView(input); }
      catch (error) {
        if (error instanceof MnemoWeaveError && ['VIEW_BUDGET_EXCEEDED', 'UNAUTHORIZED'].includes(error.code)) throw error;
        return assembleRemote(input);
      }
    };
    const sessions = new InjectionSessions({
      assemble,
      isViewUsable: async view => {
        const grant = activeBridge.storedGrant();
        return !!grant && grant.grantId === view.grantId && !activeBridge.cachedRevoked() && Date.parse(grant.expiresAt) > Date.now();
      },
      // Offline: fall back to the cached revocation flag instead of re-enabling reads.
      isRevoked: async () => {
        try { return await activeBridge.isRevokedNow() || !activeBridge.storedGrant() || Date.parse(activeBridge.storedGrant()!.expiresAt) <= Date.now(); }
        catch { return activeBridge.cachedRevoked() || activeBridge.storedGrant() === undefined || Date.parse(activeBridge.storedGrant()!.expiresAt) <= Date.now(); }
      },
    });
    const injection = createInjectionServer({ token: started.injectionToken, sessions, event: async input => { activeBridge.observeEvent(input); await Promise.race([activeBridge.drainIntents().catch(() => undefined), new Promise<void>(resolve => setTimeout(resolve, 500))]); } });
    // The read-only UI endpoint is opt-in: it exists only when the operator set its own token.
    const ui = started.uiToken === undefined ? undefined : createUiServer({ token: started.uiToken, api: activeBridge });

    process.stderr.write(logLine({ event: 'bridge_started', hostId: activeBridge.hostId, intervalMs }));
    const pass = async (): Promise<void> => {
      // Pairing fetch: the operator issues the grant over HTTP; the bridge picks it up.
      { // Fetch operator-issued replacements without extending licenses locally.
        try { await activeBridge.pair(); process.stderr.write(logLine({ event: 'bridge_paired', hostId: activeBridge.hostId })); }
        catch { process.stderr.write(logLine({ event: 'bridge_awaiting_operator_pairing' })); return; }
      }
      if (await activeBridge.isRevokedNow()) {
        process.stderr.write(logLine({ event: 'bridge_revoked_stopped_reads' }));
        return;
      }
      const result = await activeBridge.sync();
      if (result.mode !== 'incremental' || result.applied > 0) process.stderr.write(logLine({ event: 'bridge_sync', ...result }));
      const drain = await activeBridge.drainIntents();
      if (drain.submitted > 0 || drain.isolated > 0) process.stderr.write(logLine({ event: 'bridge_intents', ...drain }));
    };
    let running = false;
    const runPass = (): void => {
      if (running) return;
      running = true;
      void pass().catch(error => process.stderr.write(logLine({ event: 'bridge_pass_failed', message: String(error).slice(0, 200) }))).finally(() => { running = false; });
    };
    runPass();
    const timer = setInterval(runPass, intervalMs);
    timer.unref?.();
    return { hostId: started.hostId, port: started.injectionPort, uiPort: started.uiPort, injection, ui, close: () => { clearInterval(timer); activeBridge.close(); } };
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ event: 'bridge_configuration_invalid', message: String(error).slice(0, 200) })}\n`);
    process.exitCode = 1;
    bridge?.close();
    throw new Error('Bridge configuration invalid');
  }
}

function main(): void {
  const hosts: ReturnType<typeof createHost>[] = [];
  try {
    const profiles = process.env.MNEMOWEAVE_BRIDGE_HOSTS
      ? z.array(z.object({ hostId: z.string().min(1), token: z.string().min(24), bridgeToken: z.string().min(24).optional() }).strict()).min(1).max(16).parse(JSON.parse(process.env.MNEMOWEAVE_BRIDGE_HOSTS))
      : undefined;
    if (profiles && new Set(profiles.map(profile => profile.hostId)).size !== profiles.length) throw new Error('Duplicate Host identity');
    if (profiles) {
      for (const profile of profiles) {
        const root = process.env.MNEMOWEAVE_BRIDGE_DIR;
        if (!root) throw new Error('Bridge directory required');
        const directory = join(root, createHash('sha256').update(profile.hostId).digest('hex').slice(0, 24));
        hosts.push(createHost({ ...process.env, MNEMOWEAVE_BRIDGE_DIR: directory, MNEMOWEAVE_BRIDGE_HOST_ID: profile.hostId, MNEMOWEAVE_TOKEN: profile.token, MNEMOWEAVE_BRIDGE_TOKEN: profile.bridgeToken ?? profile.token }));
      }
    } else hosts.push(createHost(process.env));
    const router = createServer((req, res) => {
      const id = req.headers['x-mnemoweave-host'];
      const host = typeof id === 'string' ? hosts.find(host => host.hostId === id) : hosts.length === 1 ? hosts[0] : undefined;
      if (!host) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"code":"UNAUTHORIZED"}'); return; }
      host.injection.emit('request', req, res);
    });
    // Same routing rule for the read-only UI endpoint, on its own port and token.
    const uiRouter = createServer((req, res) => {
      const id = req.headers['x-mnemoweave-host'];
      const host = typeof id === 'string' ? hosts.find(host => host.hostId === id) : hosts.length === 1 ? hosts[0] : undefined;
      if (!host || !host.ui) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"code":"NOT_FOUND"}'); return; }
      host.ui.emit('request', req, res);
    });
    router.on('error', () => { process.stderr.write('{"event":"bridge_injection_listen_failed"}\n'); for (const host of hosts) host.close(); process.exitCode = 1; });
    router.listen(hosts[0]!.port, '127.0.0.1', () => process.stderr.write(JSON.stringify({ event: 'bridge_injection_listening', port: hosts[0]!.port, hosts: hosts.length }) + '\n'));
    if (hosts[0]!.ui) uiRouter.listen(hosts[0]!.uiPort, '127.0.0.1', () => process.stderr.write(JSON.stringify({ event: 'bridge_ui_listening', port: hosts[0]!.uiPort, hosts: hosts.length }) + '\n'));
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { uiRouter.close(); router.close(); for (const host of hosts) host.close(); process.exit(0); });
  } catch { for (const host of hosts) host.close(); process.stderr.write('{"event":"bridge_configuration_invalid"}\n'); process.exitCode = 1; }
}
main();
