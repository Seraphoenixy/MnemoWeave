// The bounds a scope's manifest is held to before anything is transferred.
// A pull that could not fetch a declared file must name that file here rather
// than arrive at the import path as a damaged archive.
import test from 'node:test'
import assert from 'node:assert/strict'
import { SYNC_BLOB_BYTES, SYNC_MAX_FILES, syncManifest } from '../../src/sync/protocol.ts'

test('the single-file bound matches the Pack reader per-entry limit', () => {
  // A scope that can be exported can also be synchronized.
  assert.equal(SYNC_BLOB_BYTES, 128 * 1024 * 1024)
})

test('the file count is bounded', () => {
  assert.equal(SYNC_MAX_FILES, 4096)
})

test('a manifest with no files is refused', () => {
  assert.equal(syncManifest.safeParse({ bytes: 'a'.repeat(64), files: [] }).success, false)
})

test('a manifest over the file count is refused', () => {
  const files = Array.from({ length: SYNC_MAX_FILES + 1 }, (_, index) => ({ path: `payload/${index}.md`, digest: 'b'.repeat(64) }))
  assert.equal(syncManifest.safeParse({ bytes: 'a'.repeat(64), files }).success, false)
})

test('a manifest at the file count is accepted', () => {
  const files = Array.from({ length: SYNC_MAX_FILES }, (_, index) => ({ path: `payload/${index}.md`, digest: 'b'.repeat(64) }))
  assert.equal(syncManifest.safeParse({ bytes: 'a'.repeat(64), files }).success, true)
})
