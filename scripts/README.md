# Scripts

The repository's build-time tooling. Tests and verification checks live in [`tests/`](../tests/README.md); nothing here asserts anything about behaviour.

Most run through a `package.json` script. None of these files ships in an npm package.

| Script | Run | What it does | Inputs and environment |
|---|---|---|---|
| `link-bundle-declarations.mjs` | `pnpm build` | Points the root package's emitted `dsh-mnemo-weave/*` self-references at its bundled declarations | `tsconfig.json` paths |
| `copy-component-assets.mjs` | `pnpm build` | Copies each component's presentation, locale and market files into `dist/components` | — |
| `emit-build-marker.mjs` | `pnpm build` | Atomically writes `.cache/dsh-build-complete` after all build artifacts are emitted | — |
| `watch-build.mjs` | `pnpm build:watch` | Watches `src/`, `tsdown.config.ts` and `package.json` and runs serialized `pnpm run build` | — |
| `install-antigravity.mjs` | `pnpm antigravity:install` | Builds `dist/mnemo-weave-mcp.js` when missing (or with `--build`) and installs the Antigravity plugin bundle (`plugin.json`, `mcp_config.json`, `rules/AGENTS.md`, `skills/mnemo-weave/SKILL.md`) | `--target`, `--storage-scope`, `--storage-dir`, `--workspace`, `--data-dir`, `--sync-url`, `--sync-password`, `--build`, `--no-build`, `--dry-run` |
| `install-antigravity.ps1` / `install-antigravity.sh` | PowerShell / POSIX shell | One-click wrapper that installs dependencies if missing, runs `pnpm build`, and installs the Antigravity plugin | Forwards flags to `install-antigravity.mjs` |

A file belongs here when it produces a build artifact or a distributable input. A file that decides whether the repository is correct belongs in `tests/` instead — see [Development and verification](../docs/development.md) for how the two are run.
