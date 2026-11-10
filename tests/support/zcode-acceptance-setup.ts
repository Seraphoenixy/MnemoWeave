// ZCode acceptance setup (user-facing, one command):
//   node tests/support/zcode-acceptance-setup.ts <workspaceDir>
// Installs the verified hooks block and the MnemoWeave MCP server into the workspace
// `.zcode/config.json` using the adapter's install functions, and prints the env vars
// the hook handler expects at session runtime.
import { resolve } from 'node:path';
import { installWorkspaceHooks, installWorkspaceMcp } from '../../packages/adapters/zcode/src/index.ts';

const workspace = process.argv[2];
if (!workspace) {
  process.stderr.write('usage: zcode-acceptance-setup <workspaceDir> [serverUrl] [token] [hostId]\n');
  process.exit(2);
}
const serverUrl = (process.argv[3] ?? process.env.MNEMOWEAVE_SERVER ?? 'http://127.0.0.1:4317').replace(/\/$/, '');
const token = process.argv[4] ?? process.env.MNEMOWEAVE_TOKEN ?? '';
const hostId = process.argv[5] ?? process.env.MNEMOWEAVE_HOST_ID ?? 'zcode-host';
const abs = resolve(workspace);
const handlerCommand = `node ${resolve('dist/packages/adapters/zcode/src/hook-main.js')}`;
const installed = installWorkspaceHooks(abs, handlerCommand, { timeoutMs: 2_500 });
const mcp = installWorkspaceMcp(abs, 'mnemoweave', 'node', [resolve('dist/apps/server/src/mcp-main.js')], {
  MNEMOWEAVE_SERVER: serverUrl,
  MNEMOWEAVE_HOST_ID: hostId,
  MNEMOWEAVE_TOKEN: token,
});
process.stdout.write(`${JSON.stringify({
  installed: true,
  workspace: abs,
  configPath: mcp.configPath,
  hookEvents: Object.keys((installed.hooks as { events: Record<string, unknown> }).events),
  handlerEnv: { MNEMOWEAVE_SERVER: serverUrl, MNEMOWEAVE_TOKEN: token ? '(from invocation; export before sessions)' : '(MISSING — export MNEMOWEAVE_TOKEN)', MNEMOWEAVE_HOST_ID: hostId },
  nextStep: 'Start the server, then open a real ZCode desktop session in this workspace; hook payloads land via /v1/events.',
}, null, 2)}\n`);
