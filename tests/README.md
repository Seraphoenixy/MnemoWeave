# Tests

Everything that decides whether the repository is correct, in one tree. Build tooling stays in [`scripts/`](../scripts/README.md).

```text
tests/
  unit/          behaviour of one module, no server and no Host
  integration/   two or more real parts together: the shipped server, a Host, a Pack
  checks/        the repository's own gates, run through package.json
  support/       fixtures and helpers the cases share
```

## Running

| Command | Covers |
|---|---|
| `pnpm test` | `tests/unit` — fast, no external process |
| `pnpm test:integration` | `tests/integration` — starts real servers and Hosts |
| `pnpm verify` | everything: docs, types, unit, build, Headless, sync, package |

Unit and integration cases both use Node's built-in `node:test`, run through `node --experimental-transform-types` so a case may import a `.ts` module from `src/` directly. No third-party test runner is installed: the project's heavier checks run against built artifacts and real hosts, and a runner would add an install without changing what is verified.

A case owns whatever it starts. Servers are stopped and temporary directories removed in a `finally`, so a failing case cannot leave a listener or a child process behind for the next one — a leaked child keeps the whole run alive instead of failing it.

## What lives where

`unit/` holds the cases that need nothing but a module and its arguments: the cause chain a failure reports, which failures are retried, the shape of a run record, which settings paths are writable, the manifest bounds, and how recent memory activity is read and cleared.

`integration/` holds the cases that combine real parts:

| File | Covers |
|---|---|
| `sync-server.test.mjs` | The shipped server: PAKE proof, session lifetime, two isolated MCP processes sharing Working Rules |
| `sync-activity.test.mjs` | Activity streams: concurrent appends both survive, a repeated run moves nothing, an event is never overwritten, and a clear shrinks both the stream and the server |
| `sync-host.test.mjs` | A DSH Host's run: publish, pull, idle; two machines editing one workspace; how a run is reported in the log |
| `snapshot-transfer.test.mjs` | File-by-file transfer: only changed entries move, progress counts what moved, a refused push is retried |
| `workspace-merge.test.mjs` | The real Pack merge: both machines' Documents survive, the local path is not carried, the union settles byte-identically |
| `delegation-activity.test.mjs` | What a delegated run records, and that it never records the answer |
| `sync-store.test.mjs` | Blob collection behind non-manifest batches, and pruning |

`checks/` holds the gates that need the package manager, a built artifact, or an installed DSH:

| Script | Run | What it does | Inputs and environment |
|---|---|---|---|
| `verify-docs.mjs` | `pnpm run verify:docs` | Checks local links and Markdown anchors | — |
| `verify-deterministic-build.mjs` | `pnpm run verify:build` | Builds the root package twice and compares the SHA-256 of every file under `dist/` | Must run through the package manager (`npm_execpath`) |
| `verify-package-contents.mjs` | `pnpm run verify:package` | Dry-run pack of the root package: required and unexpected files, Host code in `dist/client.js`, absolute README image URLs and the unpacked-size ceiling | — |
| `verify-public-entries.mjs` | `pnpm run verify:package`; CI on Node 20 | Imports every public Node entry, checks that declarations expose no private type, that `dsh-mnemo-weave/client` reaches neither the Host protocol nor the SDK, and runs each executable's `--help` | — |
| `verify-headless-profile.mjs` | `pnpm run verify:headless` | Installs the Starter into an isolated Headless profile of real DSH, runs one-shot tasks against a loopback model, and checks the Mnemon tools, the settings across a restart and the disabled Starter | `--package <spec> --registry <url>`, `--upgrade-from <spec> --upgrade-registry <url>`, `--strategy-extensions true`; `MNEMON_E2E_DSH` |
| `verify-windows-pnpm.mjs` | `pnpm run verify:windows-pnpm`; Windows CI | Installs a synthetic package through the real pnpm, then checks that the Mnemon CLI is discovered outside the Desktop PATH | Windows only |
| `verify-web-profile.mjs` | `node tests/checks/verify-web-profile.mjs <DSH package root> <output.json> [<packed Starter> <candidate registry>]` | Runs shipped standard and PTC Web presets with synthetic model calls and disposable state | Build packages first; no personal profile or model credentials |
| `verify-task-model-directory.mjs` | `node --experimental-transform-types tests/checks/verify-task-model-directory.mjs <DSH package.json> [output.json]` | Published DSH API-key model discovery through Mnemon | Node 22.19+ or 24 |
| `observe-node-symlink.mjs` | `node tests/checks/observe-node-symlink.mjs` | Records removal of a disposable directory symlink without following its target | macOS or Linux |

`support/` holds what those files share: `sync-fixtures.mjs` (a disposable server, an MCP client, a loopback port), `package-locales.mjs` and `package-manager.mjs`.

When `MNEMON_E2E_DSH` points at another DSH installation, run a check with `node`, not through pnpm, so that DSH inherits no `NODE_PATH`.
