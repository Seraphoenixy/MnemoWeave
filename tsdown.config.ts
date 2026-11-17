import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig, TsdownPlugin } from 'tsdown'
import { transform } from 'lightningcss'
import ts from 'typescript'

const PLUGIN_ID = 'dsh-mnemo-weave'
const PROJECT_ROOT = dirname(fileURLToPath(import.meta.url))
const CLIENT_EXTERNALS = [
  /^react(?:\/.*)?$/,
  /^react-dom(?:\/.*)?$/,
  /^@deepseek-ai\/dsh-client-ui-primitives(?:\/.*)?$/,
]
const CSS_VIRTUAL_PREFIX = '\0dsh-mnemon-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/**
 * Every component ships in this one package, so each keeps its own Cordis entry
 * point: the Loader mounts them as separate subpath Entries and DSH switches
 * them independently. Their browser code is not one of these on-demand entries;
 * it all goes into the single client bundle below, because DSH loads exactly one
 * client artifact per package.
 */
const COMPONENTS = [
  'source-runtime', 'source-documents', 'source-memory-spaces', 'source-skills',
  'strategy-auto-capture', 'provider-mnemon-native',
] as const

/** The entries each component contributes, beyond the one named after it. */
const COMPONENT_ENTRIES: Record<typeof COMPONENTS[number], string[]> = {
  'source-runtime': ['contracts'],
  'source-documents': ['contracts'],
  'source-memory-spaces': ['contracts'],
  'source-skills': ['contracts'],
  'strategy-auto-capture': [],
  'provider-mnemon-native': ['descriptor'],
}

function componentEntryPoints(): Record<string, string> {
  const entries: Record<string, string> = {}
  for (const name of COMPONENTS) {
    entries[name] = `src/components/${name}/src/index.ts`
    for (const extra of COMPONENT_ENTRIES[name]) entries[`${name}-${extra}`] = `src/components/${name}/src/${extra}.ts`
  }
  // The Memory Spaces Provider SDK is the package's own extension surface, so it
  // is exported from the root rather than from the component that hosts it.
  entries['provider-sdk'] = 'src/components/source-memory-spaces/src/provider-sdk.ts'
  entries['testing-component'] = 'src/components/source-memory-spaces/src/testing.ts'
  return entries
}

const host: UserConfig = {
  name: PLUGIN_ID,
  entry: {
    index: 'src/index.ts', bundle: 'src/bundle.ts', core: 'src/core/plugin.ts', contracts: 'src/core/contracts/index.ts',
    'extension-sdk': 'src/sdk/index.ts', testing: 'src/sdk/testing.ts', 'mnemo-weave-mcp': 'src/mcp.ts',
    ...componentEntryPoints(),
  },
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
  deps: { neverBundle: true },
  plugins: [standardDecoratorsPlugin()],
}

const syncServer: UserConfig = {
  name: 'mnemo-weave-sync-server',
  entry: { 'mnemo-weave-sync-server': 'src/sync-server.ts' },
  outDir: 'dist',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: { alwaysBundle: [/^(?:@swan-io\/srp|jsbn|zod)(?:\/|$)/u] },
  outputOptions: { banner: await syncServerNotices() },
}

async function syncServerNotices(): Promise<string> {
  const require = createRequire(import.meta.url)
  const srpManifest = require.resolve('@swan-io/srp/package.json')
  const licenses = [
    ['MnemoWeave', resolvePath(PROJECT_ROOT, 'LICENSE')],
    ['@swan-io/srp', resolvePath(dirname(srpManifest), 'LICENSE')],
    ['jsbn', resolvePath(dirname(createRequire(srpManifest).resolve('jsbn/package.json')), 'LICENSE')],
    ['zod', resolvePath(dirname(require.resolve('zod/package.json')), 'LICENSE')],
  ] as const
  const notices = await Promise.all(licenses.map(async ([name, path]) => name + '\n' + (await readFile(path, 'utf8')).trim()))
  return notices.join('\n\n').split(/\r?\n/u).map(line => '// ' + line).join('\n')
}

const client: UserConfig = {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'dist',
  format: 'cjs',
  fixedExtension: false,
  outExtensions: () => ({ js: '.js' }),
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: false,
  clean: false,
  deps: {
    neverBundle: CLIENT_EXTERNALS,
    // Component presentation assets live in this package now, so the client
    // bundle carries each component's own UI rather than importing it.
    alwaysBundle: [/^dsh-mnemo-weave\/(?:source|strategy)-[^/]+\/presentation\//,
      /^dsh-mnemo-weave\/source-memory-spaces\/client$/, /^dsh-mnemo-weave\/source-runtime\/contracts$/],
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  plugins: [clientCssPlugin()],
  outputOptions: {
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}


export function clientCssPlugin(injectStyles = true): TsdownPlugin {
  return {
    name: 'dsh-mnemon-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (source === 'dsh-mnemo-weave/client') return resolvePath(PROJECT_ROOT, 'src/client/extension-sdk.ts')
      if (!source.endsWith('.module.css')) return null
      // Component presentation assets live inside this package, so their subpath
      // specifiers resolve here rather than through a separately installed one.
      const absolute = source.startsWith(PLUGIN_ID + '/')
        ? resolvePath(PROJECT_ROOT, componentAssetPath(source))
        : importer === undefined ? source : resolveAssetPath(source, importer)
      return CSS_VIRTUAL_PREFIX + absolute + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const filename = portableRelativePath(PROJECT_ROOT, fileId)
      const { code, exports: cssExports } = transform({
        // Default Source assets share the established page-kit class namespace.
        filename: presentationNamespace(filename),
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap = stableCssClassMap(cssExports)
      const tagId = filename.match(/dsh-mnemo-weave-source-[^/]+\/presentation\/[^/]+$/)?.[0] ?? `${PLUGIN_ID}/${filename}`
      return [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        `if (${injectStyles} && typeof document !== "undefined") {`,
        '  let tag = document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]");',
        '  if (!tag) { tag = document.createElement("style"); tag.dataset.pluginCss = tagId; document.head.appendChild(tag); }',
        '  if (tag.textContent !== css) tag.textContent = css;',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }
}

/** Lower standard decorators because Rolldown currently preserves their syntax. */
function standardDecoratorsPlugin(): TsdownPlugin {
  return {
    name: 'dsh-mnemon-standard-decorators',
    transform(code: string, id: string) {
      if (!id.replaceAll('\\', '/').endsWith('/src/host/surface/remote-rpc.ts')) return null
      const output = ts.transpileModule(code, {
        fileName: id,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          verbatimModuleSyntax: true,
        },
      })
      return { code: output.outputText, map: null }
    },
  }
}

function resolveAssetPath(source: string, importer: string): string {
  return resolvePath(dirname(importer), source)
}

/**
 * Map a component asset specifier such as
 * `dsh-mnemo-weave/source-runtime/presentation/page.module.css` to the file it
 * names inside this package.
 */
function componentAssetPath(specifier: string): string {
  const match = /^dsh-mnemo-weave\/([a-z0-9-]+)\/presentation\/([a-z0-9.-]+)$/u.exec(specifier)
  if (match === null) return specifier
  return `src/components/${match[1]}/presentation/${match[2]}`
}

export function portableRelativePath(root: string, path: string): string {
  return relative(root, path).replaceAll('\\', '/')
}

export function presentationNamespace(filename: string): string {
  if (/components\/[a-z0-9-]+\/presentation\/page\.module\.css$/u.test(filename)) return 'src/client/MnemonView.module.css'
  if (/components\/[a-z0-9-]+\/presentation\/sidebar\.module\.css$/u.test(filename)) return 'src/client/MnemonSidebarView.module.css'
  return filename
}

export function stableCssClassMap(cssExports: Record<string, { name: string }> | void): Record<string, string> {
  return Object.fromEntries(Object.entries(cssExports ?? {})
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([local, exported]) => [local, exported.name]))
}

export default [host, syncServer, client]
