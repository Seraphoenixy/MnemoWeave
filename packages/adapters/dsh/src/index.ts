/**
 * DSH adapter — BLOCKED (WP7, HOST-01 verification 2026-11-08).
 *
 * Machine finding (2026-11-09): the desktop app is installed under
 * %LOCALAPPDATA%\Programs\DeepSeek Harness, but `dsh.cmd` still reports "Harness CLI not
 * found" — the CLI/runtime has not been initialized by a first desktop run.
 * Per host-integration.md the adapter must be written against the ACTUAL installed SDK
 * ("依据实际 SDK 编写 DSH 适配器"); designing against the dsh-mnemon plugin's private
 * SDK without the harness runtime would violate the evidence rules (plugin-private SDK
 * is not a stable public API). No runnable adapter code is provided; the capability
 * declaration stays unverified and HOST-02 acceptance for DSH is blocked until the
 * harness is installed.
 *
 * When the harness is installed, implement against the real SDK:
 * 1. Verify the installed DSH version against the dsh-mnemon peer range
 *    (>=0.2.0-rc.2 <0.2.1-0 || >=0.2.1-rc.1 <0.3.0-0) and record it.
 * 2. Map harness lifecycle events (session/event, user/message, assistant/message,
 *    tool/call, tool/result, turn/end, system-prompt/assemble) onto HostEvent and the
 *    shared-sdk InjectionController.
 * 3. Run the HOST-02 acceptance scenario list and record results.
 */
export const DSH_HOST_FACTS = {
  product: 'DSH' as const,
  status: 'blocked' as const,
  blocker: 'Harness Desktop installed at %LOCALAPPDATA%\\Programs\\DeepSeek Harness; dsh.cmd still reports harness CLI missing (first-run CLI/runtime initialization incomplete)',
  evidence: 'dsh.cmd --version probe 2026-11-09; desktop resources/runtime/versions.json (node 24.21.0, pnpm 11.28.5); work/upstream/dsh-mnemon source available for SDK study only',
};
