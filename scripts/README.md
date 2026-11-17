# Scripts

The repository's build-time tooling. Tests and verification checks live in [`tests/`](../tests/README.md); nothing here asserts anything about behaviour.

Most run through a `package.json` script. None of these files ships in an npm package.

| Script | Run | What it does | Inputs and environment |
|---|---|---|---|
| `link-bundle-declarations.mjs` | `pnpm build` | Points the root package's emitted `dsh-mnemo-weave/*` self-references at its bundled declarations | `tsconfig.json` paths |
| `copy-component-assets.mjs` | `pnpm build` | Copies each component's presentation, locale and market files into `dist/components` | — |

A file belongs here when it produces a build artifact or a distributable input. A file that decides whether the repository is correct belongs in `tests/` instead — see [Development and verification](../docs/development.md) for how the two are run.
