#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { syncAuthRecord } from './sync/auth-protocol.ts'
import { createSyncAuthRecord, SyncAuthentication } from './sync/server/auth.ts'
import { createSyncServer } from './sync/server/http.ts'
import { SqliteSyncStore } from './sync/server/sqlite.ts'

const { values } = parseArgs({ options: { 'init-auth': { type: 'boolean' } } })
const directory = resolve(process.env.MNEMOWEAVE_SYNC_DATA_DIR ?? './mnemo-sync-data')
const authPath = resolve(process.env.MNEMOWEAVE_SYNC_AUTH_FILE ?? join(directory, 'auth.json'))

if (values['init-auth']) {
  const password = readFileSync(0, 'utf8').replace(/\r?\n$/u, '')
  const record = await createSyncAuthRecord(password)
  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 })
  const temporary = authPath + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(temporary, JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx' })
    // Publish atomically and leave an existing verifier untouched.
    linkSync(temporary, authPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    throw new Error('Sync authentication file already exists: ' + authPath)
  } finally {
    rmSync(temporary, { force: true })
  }
  console.log('Initialized sync authentication: ' + authPath)
} else {
  const port = Number(process.env.MNEMOWEAVE_SYNC_PORT ?? 4319)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid MNEMOWEAVE_SYNC_PORT')
  let contents: string
  try {
    contents = readFileSync(authPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    throw new Error('Sync authentication file is missing. Run --init-auth locally first: ' + authPath)
  }
  let parsed: unknown
  try { parsed = JSON.parse(contents) } catch { throw new Error('Invalid sync authentication JSON: ' + authPath) }
  const record = syncAuthRecord.safeParse(parsed)
  if (!record.success) throw new Error('Invalid sync authentication file: ' + authPath)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const store = new SqliteSyncStore(join(directory, 'sync.sqlite'))
  const server = createSyncServer(store, new SyncAuthentication(record.data))
  server.listen(port, '127.0.0.1', () => console.log(`MnemoWeave sync server listening on 127.0.0.1:${port}`))
  const stop = () => server.close(() => store.close())
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
}
