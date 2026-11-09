import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configure } from './config.ts';
import { httpMemoryClient } from './http-memory-client.ts';
import { createMcpServer } from '../../../packages/protocols/mcp/src/index.ts';

try {
  let close: () => Promise<void> = async () => {};
  let app;
  if (process.env.MNEMOWEAVE_MCP_MODE === 'standalone') {
    // Explicit isolated acceptance mode; never start another Worker for each Host.
    const configured = configure({ ...process.env, MNEMOWEAVE_WORKER: 'off' });
    app = configured.app; close = configured.close;
  } else {
    app = httpMemoryClient(process.env.MNEMOWEAVE_SERVER ?? 'http://127.0.0.1:4317', process.env.MNEMOWEAVE_TOKEN ?? '', process.env.MNEMOWEAVE_BRIDGE_HOST_ID ?? '', process.env.MNEMOWEAVE_SESSION_ID);
  }
  const server = createMcpServer(app);
  server.server.onclose = () => { void close(); };
  await server.connect(new StdioServerTransport());
} catch { process.stderr.write('{"event":"mcp_start_failed"}\n'); process.exitCode = 1; }
