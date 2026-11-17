// The memory components the dsh-mnemo-weave Starter ships, named once for the
// Host, the browser client and the repository scripts. Keep this file plain
// data with erasable types only and no imports: the scripts load it as is,
// with Node's own TypeScript support, without a build step.

/**
 * The component rows the Starter's bundle patch (cordis.patch.yml) declares,
 * in its order: each row's id, the Entry name that loads it, and the component
 * it names. These entries are composed into the runtime group. The memory
 * settings panel lists the components by `componentId`; profile overrides
 * address the Loader entry by its row id.
 */
export const STARTER_COMPONENT_ROWS: ReadonlyArray<{ rowId: string; componentId: string; packageName: string }> = [
  { rowId: 'mnemon-source-runtime', componentId: 'source-runtime', packageName: 'dsh-mnemo-weave/source-runtime' },
  { rowId: 'mnemon-source-documents', componentId: 'source-documents', packageName: 'dsh-mnemo-weave/source-documents' },
  { rowId: 'mnemon-source-memory-spaces', componentId: 'source-memory-spaces', packageName: 'dsh-mnemo-weave/source-memory-spaces' },
  { rowId: 'mnemon-source-skills', componentId: 'source-skills', packageName: 'dsh-mnemo-weave/source-skills' },
  { rowId: 'mnemon-strategy-auto-capture', componentId: 'strategy-auto-capture', packageName: 'dsh-mnemo-weave/strategy-auto-capture' },
]

/** The single enhancement the Starter ships switched off, which the Host suggests for installation. */
export const STARTER_ENHANCEMENT_PACKAGES: readonly string[] = [
  'dsh-mnemo-weave/strategy-auto-capture',
]

/**
 * The shipped components that carry a bundle patch of their own. None do: every
 * component ships in `dsh-mnemo-weave`, whose patch declares each row, so a
 * component cannot register a row beside it.
 */
export const STARTER_SELF_REGISTERING_PACKAGES: readonly string[] = []
