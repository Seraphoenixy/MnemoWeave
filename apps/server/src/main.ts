import { configure } from './config.ts';
import { createHttpServer } from '../../../packages/protocols/http/src/index.ts';
import { inspectPort } from './instance-guard.ts';

try {
  const token = process.env.MNEMOWEAVE_TOKEN ?? '';
  // Probe before `configure()`. Configuring opens the governance database and starts the Worker
  // and sync loop, so a second process would already have begun touching the same state before
  // discovering that the port belongs to the first one. The port is known from the environment,
  // which is the same source `configure()` reads it from.
  const declaredPort = Number(process.env.MNEMOWEAVE_PORT ?? '4317');
  const before = await inspectPort({ port: declaredPort, token });
  if (before === 'ours') {
    // A Server is already serving this port; the host should connect to that one.
    process.stderr.write(`${JSON.stringify({ event: 'already_running', port: declaredPort })}\n`);
    process.exit(0);
  }
  if (before === 'foreign') {
    process.stderr.write(`${JSON.stringify({ event: 'port_not_ours', port: declaredPort })}\n`);
    process.exit(1);
  }
  const { app, port, close, client, storage } = configure();
  // `MNEMOWEAVE_PORT=0` asks the OS for a free port, so the pre-check above only covers a fixed
  // port. Re-check the resolved port in case another process took it in between.
  if (port !== declaredPort) {
    const after = await inspectPort({ port, token });
    if (after !== 'free') {
      process.stderr.write(`${JSON.stringify({ event: 'already_running', port })}\n`);
      await close();
      process.exit(0);
    }
  }
  const server = createHttpServer(app, token, process.env.MNEMOWEAVE_OPERATOR_TOKEN, client, storage);
  server.once('close', () => { void close(); });
  server.listen(port, '127.0.0.1', () => {
    process.stderr.write(`${JSON.stringify({ event: 'listening', address: server.address(), version: '0.2.0' })}\n`);
  });
  server.on('error', () => { process.stderr.write('{"event":"listen_failed"}\n'); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close());
} catch (error) {
  // The event name alone made a real misconfiguration indistinguishable from a startup race.
  // The message is a fixed, non-secret string from our own validation code.
  const detail = error instanceof Error ? error.message.slice(0, 200) : 'unknown';
  process.stderr.write(`${JSON.stringify({ event: 'configuration_invalid', detail })}\n`);
  process.exitCode = 1;
}
