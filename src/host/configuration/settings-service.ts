import { canonicalMemoryJson } from '../../core/definitions.ts'
import type { HostContextShape, HostSettingsScope, HostSettingsService } from '../support/dsh.ts'
import type { SettingsOperation } from '../contracts/protocol.ts'
import { plainHostConfig } from './live-config.ts'

type NativeDescriptor = ReturnType<HostSettingsService['describe']>[number]
type SettingsListener = (namespace: string, value: unknown) => void
type Registration = {
  namespace: string
  field?: 'conversationInteraction' | 'memoryView' | 'skills'
  schema: (value: unknown) => unknown
  validate?: (value: never) => void
}

interface ProfileEntry {
  id?: string
  options: { id: string; config?: unknown }
}

interface ProfileFiber {
  entry?: ProfileEntry
  config: unknown
}

interface ProfileEditor {
  entries(): ProfileEntry[]
}

interface ProfileForms {
  readonly writable: boolean
  configure(presentation: { auto: boolean }, owner: ProfileFiber): () => void
  describe(options?: { redactSecrets?: boolean }): ReturnType<HostSettingsService['describe']>
  mutate(namespace: string, operations: SettingsOperation[], expectedRevision?: number): Promise<void>
}

const clone = <T>(value: T): T => structuredClone(value)
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** A local facade preserves Mnemon's wire namespaces; DSH owns all persistence. */
export class ProfileMnemonSettings implements HostSettingsService {
  private readonly registrations = new Map<string, Registration>()
  private readonly listeners = new Set<SettingsListener>()
  private readonly revisions = new Map<number, NativeDescriptor>()
  private readonly owner: ProfileFiber | undefined
  private readonly forms: ProfileForms
  private readonly editor: ProfileEditor | undefined
  private closed = false

  constructor(ctx: HostContextShape, private readonly input: unknown) {
    this.forms = ctx.settings as unknown as ProfileForms
    this.owner = (ctx as unknown as { fiber?: ProfileFiber }).fiber
    this.editor = ctx.get('configEditor') as ProfileEditor | undefined
    const owner = this.owner
    const validate = (candidate: unknown): void => {
      const config = plainHostConfig(candidate)
      for (const registration of this.registrations.values()) {
        const value = this.resolve(registration, config)
        registration.validate?.(value as never)
      }
    }
    // The public Cordis waterfall is also run by ConfigEditor before it writes.
    // Scope by fiber: another plugin's config must never initialize our graph.
    ctx.on('internal/config', function (this: ProfileFiber, _raw: unknown, next: () => unknown) {
      const candidate = next()
      if (this === owner) validate(candidate)
      return candidate
    } as never, { prepend: true })
    ctx.on('loader/volatile-update', ((paths: readonly (readonly string[])[]) => {
      if (this.closed) return
      for (const registration of this.registrations.values()) {
        // A change to a field another namespace owns is that namespace's alone: 技能管理's settings
        // never rebuild the memory runtime.
        const changed = paths.some(path => registration.field === undefined
          ? path.length === 0 || !['memoryView', 'skills'].includes(path[0]!)
          : path.length === 0 || path[0] === registration.field)
        if (!changed) continue
        const value = this.resolve(registration)
        for (const listener of this.listeners) {
          try { listener(registration.namespace, value) }
          catch (error) { console.warn('dsh-mnemo-weave: committed settings listener failed', error) }
        }
      }
    }) as never)
    ctx.effect(() => {
      const disposePresentation = owner === undefined ? undefined : this.forms.configure({ auto: false }, owner)
      return () => {
        this.closed = true
        this.listeners.clear()
        this.revisions.clear()
        disposePresentation?.()
      }
    }, 'dsh-mnemo-weave: profile settings')
  }

  get writable(): boolean {
    const entry = this.owner?.entry
    return !this.closed && this.forms.writable && entry !== undefined && this.editor?.entries().includes(entry) === true
  }

  onUpdated(listener: SettingsListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private resolve(registration: Registration, config = plainHostConfig(this.owner?.config ?? this.input)): unknown {
    const value = registration.field === undefined ? config : config[registration.field]
    return registration.schema(object(value))
  }

  register<T>(namespace: string, schema: unknown, options: { base?: Partial<T>; applies: 'live' | 'restart'; validate?: (value: T) => void }): HostSettingsScope<T> {
    if (this.registrations.has(namespace)) throw new Error(`Mnemon settings already registered: ${namespace}`)
    if (typeof schema !== 'function') throw new Error('Mnemon settings require a schema')
    const field = namespace === 'mnemon-ui' ? 'conversationInteraction'
      : namespace === 'mnemon-skills' ? 'skills'
      : /^mnemon-view(?:-[a-f0-9]{16})?$/u.test(namespace) ? 'memoryView' : undefined
    if (namespace !== 'mnemon' && field === undefined) throw new Error('Unsupported Mnemon settings namespace')
    const registration: Registration = { namespace, ...(field === undefined ? {} : { field }), schema: schema as Registration['schema'], ...(options.validate === undefined ? {} : { validate: options.validate }) }
    const value = this.resolve(registration)
    options.validate?.(value as T)
    this.registrations.set(namespace, registration)
    return { get: () => this.resolve(registration) as T }
  }

  private nativeDescriptor(): NativeDescriptor | undefined {
    if (this.closed || this.owner?.entry === undefined || !this.editor?.entries().includes(this.owner.entry)) return undefined
    const descriptor = this.forms.describe().find(item => item.ns === this.owner?.entry?.options.id)
    if (descriptor !== undefined) {
      this.revisions.set(descriptor.revision, clone({
        ns: descriptor.ns, revision: descriptor.revision, applies: descriptor.applies,
        value: descriptor.value, base: descriptor.base, user: descriptor.user,
      }))
      if (this.revisions.size > 64) this.revisions.delete(this.revisions.keys().next().value!)
    }
    return descriptor
  }

  private unchanged(previous: NativeDescriptor, current: NativeDescriptor, registration: Registration, operations: SettingsOperation[]): boolean {
    const project = (value: unknown): unknown => {
      if (registration.field !== undefined) return object(value)[registration.field]
      const { memoryView: _view, skills: _skills, conversationInteraction, ...core } = object(value)
      return operations.some(operation => operation.path[0] === 'conversationInteraction')
        ? { ...core, conversationInteraction } : core
    }
    const signature = (descriptor: NativeDescriptor) => canonicalMemoryJson(JSON.parse(JSON.stringify([
      project(descriptor.value) ?? null, project(descriptor.base) ?? null, project(descriptor.user) ?? null,
    ])))
    return signature(previous) === signature(current)
  }

  describe(options?: { redactSecrets?: boolean }): ReturnType<HostSettingsService['describe']> {
    const raw = this.nativeDescriptor()
    if (raw === undefined) return []
    const descriptor = options?.redactSecrets
      ? this.forms.describe(options).find(item => item.ns === this.owner?.entry?.options.id) : raw
    if (descriptor === undefined) return []
    return [...this.registrations.values()].map(registration => {
      const project = (value: unknown): unknown => registration.field === undefined ? value : object(value)[registration.field]
      return {
        ns: registration.namespace,
        value: project(descriptor.value) ?? {},
        base: project(descriptor.base) ?? {},
        user: project(descriptor.user) ?? {},
        revision: descriptor.revision,
        applies: 'live' as const,
      }
    })
  }

  async mutate(namespace: string, operations: SettingsOperation[], expectedRevision?: number): Promise<void> {
    const registration = this.registrations.get(namespace)
    if (registration === undefined) throw new Error('Unsupported Mnemon settings namespace')
    if (!this.writable) throw new Error('DSH settings are read-only')
    const translated = operations.map(operation => ({
      ...operation,
      path: [...(registration.field === undefined ? [] : [registration.field]), ...operation.path],
    }))
    let revision = expectedRevision
    const previous = revision === undefined ? undefined : this.revisions.get(revision)
    for (let attempt = 0; ; attempt += 1) {
      if (!this.writable) throw new Error('DSH settings are read-only')
      try {
        await this.forms.mutate(this.owner!.entry!.options.id, translated, revision)
        return
      } catch (error) {
        // All namespaces share one entry revision. Rebase only when this namespace's
        // values and overrides still match the snapshot the caller observed.
        if (attempt >= 2 || previous === undefined || typeof error !== 'object' || error === null
          || !('code' in error) || error.code !== 'SETTINGS_CONFLICT') throw error
        if (!this.writable) throw new Error('DSH settings are read-only')
        const current = this.nativeDescriptor()
        if (current === undefined || !this.unchanged(previous, current, registration, operations)) throw error
        revision = current.revision
      }
    }
  }
}
