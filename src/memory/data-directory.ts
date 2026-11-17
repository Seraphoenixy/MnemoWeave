import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function expandStorageDirectory(value: string): string {
  return resolve(value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value)
}

export function globalMemoryDirectory(): string {
  return expandStorageDirectory(process.env.MNEMON_DATA_DIR?.trim() || '~/.mnemon')
}
