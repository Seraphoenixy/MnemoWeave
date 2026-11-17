/**
 * One installation's identity, kept in the data directory's state area.
 *
 * state/ is deliberately not a Pack component: the identity describes *this*
 * machine and must never travel in a backup, or two machines would sign their
 * entries with the same id and a merge could no longer tell them apart. What
 * does travel is the provenance stamped onto entries and the manifest.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { machineLabelValid, MNEMON_MACHINE_LABEL_MAX, type MnemonMachineIdentity, type MnemonMachineLabelSource } from '../contracts/protocol.ts'
import type { StorageRoot } from '../engine/storage-root.ts'

export const MNEMON_MACHINE_DIRECTORY = 'state'
export const MNEMON_MACHINE_FILE = 'machine.json'
const MNEMON_MACHINE_VERSION = 1

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** The name a fresh identity carries: the host name, or a neutral fallback. */
export function defaultMachineLabel(): string {
  const name = hostname().trim()
  const label = name === '' ? 'this machine' : name
  return label.length > MNEMON_MACHINE_LABEL_MAX ? label.slice(0, MNEMON_MACHINE_LABEL_MAX) : label
}

/** A name a person gives this machine, as it is stored and shown. */
export function machineLabel(value: unknown): string {
  const label = typeof value === 'string' ? value.trim() : ''
  if (!machineLabelValid(label)) throw new Error('machine name must be 1 to ' + String(MNEMON_MACHINE_LABEL_MAX) + ' characters on one line')
  return label
}

/** The identity as this machine uses it, with where its name comes from. */
export interface MnemonMachineRecord {
  identity: MnemonMachineIdentity
  source: MnemonMachineLabelSource
}

/**
 * The machine identity store. One file, one identity, created on first read and
 * then stable for the life of the data directory: an id that changed would
 * make every earlier entry look like it came from another machine.
 *
 * The name is not part of that promise. A host-name label follows the computer's
 * host name, and a person can name the machine instead. Every read goes to the
 * file, because the pack manager and the sync channel each hold a store and a
 * rename through one has to reach what the other stamps.
 */
export class MnemonMachineStore {
  private readonly root: string

  constructor(runner: Pick<StorageRoot, 'effectiveDataDir'>) {
    this.root = resolve(runner.effectiveDataDir())
  }

  directory(): string {
    return join(this.root, MNEMON_MACHINE_DIRECTORY)
  }

  path(): string {
    return join(this.directory(), MNEMON_MACHINE_FILE)
  }

  /** This installation's identity, creating and persisting one when none exists yet. */
  read(): MnemonMachineIdentity {
    return this.current().identity
  }

  /** The identity with the source of its name, bringing the stored record up to date. */
  current(): MnemonMachineRecord {
    const stored = this.stored()
    if (stored === undefined) return this.write({ id: randomUUID(), label: defaultMachineLabel(), createdAt: new Date().toISOString() }, 'hostname')
    if (stored.source === 'hostname') {
      // The host name may have changed since the record was written; the name follows it.
      const label = defaultMachineLabel()
      if (stored.identity.label !== label || !stored.marked) return this.write({ ...stored.identity, label }, 'hostname')
    } else if (!stored.marked) {
      return this.write(stored.identity, 'custom')
    }
    return { identity: stored.identity, source: stored.source }
  }

  /**
   * Name this machine. A typed name stays as given; null or an empty name goes back
   * to the host name. The id never changes, so earlier entries keep pointing here.
   */
  rename(value: unknown): MnemonMachineRecord {
    const label = value === null || value === '' ? undefined : machineLabel(value)
    const identity = this.current().identity
    return label === undefined
      ? this.write({ ...identity, label: defaultMachineLabel() }, 'hostname')
      : this.write({ ...identity, label }, 'custom')
  }

  private stored(): (MnemonMachineRecord & { marked: boolean }) | undefined {
    let value: unknown
    try {
      value = JSON.parse(readFileSync(this.path(), 'utf8')) as unknown
    } catch {
      return undefined
    }
    const parsed = record(value)
    if (parsed?.version !== MNEMON_MACHINE_VERSION) return undefined
    if (typeof parsed.id !== 'string' || parsed.id.trim() === '') return undefined
    if (typeof parsed.label !== 'string' || parsed.label.trim() === '') return undefined
    if (typeof parsed.createdAt !== 'string') return undefined
    const identity = { id: parsed.id, label: parsed.label, createdAt: parsed.createdAt }
    if (parsed.labelSource === 'hostname' || parsed.labelSource === 'custom') return { identity, source: parsed.labelSource, marked: true }
    // Earlier versions recorded no source and always named the machine after its host.
    // A label that is still the host name keeps following it; any other label was set
    // by hand, and a hand-set name stays.
    return { identity, source: parsed.label === defaultMachineLabel() ? 'hostname' : 'custom', marked: false }
  }

  private write(identity: MnemonMachineIdentity, source: MnemonMachineLabelSource): MnemonMachineRecord {
    mkdirSync(this.directory(), { recursive: true, mode: 0o700 })
    const temporary = `${this.path()}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, `${JSON.stringify({ version: MNEMON_MACHINE_VERSION, ...identity, labelSource: source }, null, 2)}\n`, { mode: 0o600 })
      renameSync(temporary, this.path())
    } finally {
      rmSync(temporary, { force: true })
    }
    return { identity, source }
  }
}
