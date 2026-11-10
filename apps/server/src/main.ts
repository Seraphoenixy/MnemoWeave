import { configure } from './config.ts';
import { createHttpServer } from '../../../packages/protocols/http/src/index.ts';

try {
  const { app, port, close, client, storage } = configure();
  const server = createHttpServer(app, process.env.MNEMOWEAVE_TOKEN ?? '', process.env.MNEMOWEAVE_OPERATOR_TOKEN, client, storage);
  server.once('close', () => { void close(); });
  server.listen(port, '127.0.0.1', () => {
    process.stderr.write(`${JSON.stringify({ event: 'listening', address: server.address(), version: '0.2.0' })}\n`);
  });
  server.on('error', () => { process.stderr.write('{"event":"listen_failed"}\n'); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close());
} catch { process.stderr.write('{"event":"configuration_invalid"}\n'); process.exitCode = 1; }
