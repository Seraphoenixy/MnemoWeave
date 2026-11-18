import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { buildAntigravityMcpConfig, installAntigravityPlugin } from '../../scripts/install-antigravity.mjs'

test('installAntigravityPlugin writes plugin bundle and resolved mcp_config.json into isolated target', () => {
  const target = mkdtempSync(join(tmpdir(), 'mnemo-antigravity-'))
  try {
    const result = installAntigravityPlugin({
      target,
      storageScope: 'workspaces',
      storageDir: join(target, 'spaces'),
    })

    assert.equal(result.dryRun, false)
    assert.equal(result.targetDir, resolve(target))

    for (const file of ['plugin.json', 'mcp_config.json', join('rules', 'AGENTS.md'), join('skills', 'mnemo-weave', 'SKILL.md')]) {
      assert.equal(existsSync(join(target, file)), true, `Expected ${file} to exist`)
    }

    const pluginManifest = JSON.parse(readFileSync(join(target, 'plugin.json'), 'utf8'))
    assert.equal(pluginManifest.name, 'mnemo-weave')

    const mcpConfig = JSON.parse(readFileSync(join(target, 'mcp_config.json'), 'utf8'))
    const server = mcpConfig.mcpServers.mnemo_weave
    assert.equal(server.command, 'node')
    assert.ok(server.args[0].endsWith('/dist/mnemo-weave-mcp.js'))
    assert.ok(!server.args[0].includes('\\'))
    assert.deepEqual(server.args.slice(1), [
      '--storage-scope',
      'workspaces',
      '--storage-dir',
      resolve(target, 'spaces').replaceAll('\\', '/'),
    ])

    const rules = readFileSync(join(target, 'rules', 'AGENTS.md'), 'utf8')
    assert.equal(rules.startsWith('---'), false)
    assert.ok(rules.includes('mnemo_working_rules'))

    const skill = readFileSync(join(target, 'skills', 'mnemo-weave', 'SKILL.md'), 'utf8')
    assert.ok(skill.startsWith('---\nname: mnemo-weave\n'))
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('buildAntigravityMcpConfig rejects invalid storageScope or missing custom storageDir', () => {
  assert.throws(() => buildAntigravityMcpConfig({ storageScope: 'invalid' }), /Invalid --storage-scope/)
  assert.throws(() => buildAntigravityMcpConfig({ storageScope: 'custom' }), /--storage-dir is required/)
  assert.throws(() => buildAntigravityMcpConfig({ dataDir: 'relative/path' }), /--data-dir must be an absolute/)
})
