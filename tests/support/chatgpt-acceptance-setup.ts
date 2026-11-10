import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { chatgptHooksJson, chatgptMcpConfig } from '../../packages/adapters/chatgpt/src/index.ts';

const server = process.env.MNEMOWEAVE_SERVER;
const token = process.env.MNEMOWEAVE_TOKEN;
const host = process.env.MNEMOWEAVE_HOST_ID;
if (!server || !token || token.length < 24 || !host) throw new Error('Provide Server URL, issued Host credential and Host identity');
const directory = resolve('work/chatgpt-acceptance');
mkdirSync(directory, { recursive: true });
const command = `"${process.execPath}" "${resolve('dist/packages/adapters/chatgpt/src/hook-main.js')}"`;
writeFileSync(join(directory, 'hooks.json'), chatgptHooksJson(command, 'local-only'));
writeFileSync(join(directory, 'mcp.toml'), chatgptMcpConfig(process.execPath, [resolve('dist/apps/server/src/mcp-main.js')], { MNEMOWEAVE_SERVER: server, MNEMOWEAVE_TOKEN: token, MNEMOWEAVE_HOST_ID: host }));
process.stdout.write(JSON.stringify({ generated: directory, mode: 'local-only', installed: false, next: 'Review the generated files in the target desktop Host; export MNEMOWEAVE_CHATGPT_MODE=local-only and the same Server/Host environment for command hooks, then run a real desktop session.' }) + '\n');
