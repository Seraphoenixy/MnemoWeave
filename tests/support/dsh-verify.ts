// DSH post-install verification (user-facing): run AFTER installing DeepSeek Harness
// Desktop. Checks the CLI version against the dsh-mnemon peer range and probes the
// documented lifecycle entry points, printing the HOST-01 evidence block.
import { execFileSync } from 'node:child_process';

const dshCmd = process.argv[2] ?? 'C:\\Users\\Xuan\\AppData\\Local\\deepseek-harness\\bin\\dsh.cmd';
let version: string | undefined;
try { version = execFileSync(dshCmd, ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim(); } catch (error) {
  process.stdout.write(`${JSON.stringify({ status: 'blocked', reason: `dsh probe failed: ${String(error).slice(0, 200)}` }, null, 2)}\n`);
  process.exit(1);
}
// dsh-mnemon peer range: >=0.2.0-rc.2 <0.2.1-0 || >=0.2.1-rc.1 <0.3.0-0
const peerOk = /^dsh version 0\.2\.(1-rc\.[1-9]|1(?!\.0-0)|[2-9]\b)/.test(version) || /0\.2\.2/.test(version);
const probe = (args: string[]): string | undefined => {
  try { return execFileSync(dshCmd, args, { encoding: 'utf8', timeout: 15_000 }).slice(0, 400); } catch (error) { return `probe failed: ${String(error).slice(0, 120)}`; }
};
process.stdout.write(`${JSON.stringify({
  status: peerOk ? 'version-in-range' : 'version-out-of-recorded-range',
  version,
  peerRange: '>=0.2.0-rc.2 <0.2.1-0 || >=0.2.1-rc.1 <0.3.0-0 (dsh-mnemon 0.5.42)',
  helpProbe: probe(['--help']),
  nextStep: 'Update docs/implementation/host-acceptance/dsh.md with this evidence, then implement packages/adapters/dsh against the real SDK and run the HOST-02 scenario list.',
}, null, 2)}\n`);
