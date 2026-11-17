# Scripts

The repository's own tooling: the checks `pnpm run verify` chains and the real-host WebUI checks. [Development and verification](../docs/development.md) describes how they fit together.

Most scripts run through a `package.json` script; run the rest with `node` from the repository root, after `pnpm build` and `pnpm --workspace-concurrency=1 -r build` when they load built packages. When `MNEMON_E2E_DSH` points at another DSH installation, run the script with `node`, not through pnpm, so that DSH inherits no `NODE_PATH`. None of these files ships in an npm package. `verify-headless-profile.mjs` takes the Starter's component lists from `src/host/contracts/starter-components.ts`, which Node loads as TypeScript without a build step. Reusable tooling for an evidence record belongs here, and the record links to it.

## Checks

| Script | Run | What it does | Inputs and environment |
|---|---|---|---|
| `verify-docs.mjs` | `pnpm run verify:docs` | Checks local links and Markdown anchors | — |
| `verify-deterministic-build.mjs` | `pnpm run verify:build` | Builds the root package twice and compares the SHA-256 of every file under `dist/` | Must run through the package manager (`npm_execpath`; a JavaScript entry runs through Node, a standalone executable runs directly) |
| `link-bundle-declarations.mjs` | `pnpm build` | Points the root package's emitted `dsh-mnemo-weave/*` self-references at its bundled declarations | `tsconfig.json` paths |
| `copy-component-assets.mjs` | `pnpm build` | Copies each component's presentation, locale and market files into `dist/components` | — |
| `package-locales.mjs` | Imported by the next two | Reads and validates a package's `locale/*.json` metadata | — |
| `verify-package-contents.mjs` | `pnpm run verify:package` | Dry-run pack of the root package: required and unexpected files, Host code in `dist/client.js`, absolute README image URLs and the unpacked-size ceiling | — |
| `verify-public-entries.mjs` | `pnpm run verify:package`; CI on Node 20 | Imports every public Node entry of the root, Memory Spaces and Layered strategy packages, checks that their declarations expose no private type, checks that `dsh-mnemo-weave/client`'s declarations import only React and DSH's primitives and reach neither the Host protocol, the SDK nor a cordis Context augmentation, and runs each executable's `--help` | — |
| `verify-headless-profile.mjs` | `pnpm run verify:headless` | Installs the Starter into an isolated Headless profile of real DSH, runs one-shot tasks against a loopback model, and checks the Mnemon tools, the settings across a restart and the disabled Starter | `--package <spec> --registry <url>`, `--upgrade-from <spec> --upgrade-registry <url>`, `--strategy-extensions true`; `MNEMON_E2E_DSH` |
| `verify-windows-pnpm.mjs` | `pnpm run verify:windows-pnpm`; Windows CI | Installs a synthetic package through the real pnpm, then checks that the Mnemon CLI is discovered outside the Desktop PATH and runs with literal arguments and the intended cwd | Windows only; must run through pnpm |
| `package-manager.mjs` | Imported by the checks that rebuild | Resolves how to run a script through the package manager that started this process | `npm_execpath` |

## Real host and Provider Lab

| Script | Run | What it does | Inputs and environment |
|---|---|---|---|
| `verify-web-profile.mjs` | `node scripts/verify-web-profile.mjs <DSH package root> <output.json> [<packed Starter> <candidate registry>]` | Runs shipped standard and PTC Web presets with synthetic model calls, disposable state and linked built packages or a packed Starter; checks actual status/document reads and completed turns | Build packages first; no personal profile or model credentials |
| `verify-task-model-directory.mjs` | `node --experimental-transform-types scripts/verify-task-model-directory.mjs <DSH package.json> [output.json]` | Published DSH API-key model discovery through Mnemon, with a synthetic 3.6-second response; asserts first-load success and makes no external request | Node 22.19+ or 24; path to the installed DSH manifest |
| `observe-node-symlink.mjs` | `node scripts/observe-node-symlink.mjs` | Records removal of a disposable directory symlink without following its target; reproduces the early Node 24 macOS limitation in the current DSH evidence | macOS or Linux; run with each Node binary being compared |
