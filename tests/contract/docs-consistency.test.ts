import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { openapi } from '../../packages/core/contracts/src/index.ts';
import { SqliteCandidates } from '../../packages/infrastructure/governance/src/index.ts';
import { tempDir } from '../support/temp.ts';

/**
 * Documentation is part of the contract here, so it is checked like code.
 *
 * Both rules below caught real drift: `docs/ui.md` documented a `/confirm` route that had been
 * removed, and the README still claimed schema v10 while the code had reached v14. A reader would
 * have trusted either one.
 */

const read = (path: string): string => readFileSync(resolve(path), 'utf8');

test('the schema version the docs call current is the one the code creates', async () => {
  const root = await tempDir('docs-consistency', 'docs-schema');
  const path = join(root, 'governance.db');
  // Creating a fresh store runs the whole migration chain, so its version is the real answer.
  const repo = new SqliteCandidates(path);
  repo.close();
  const probe = new DatabaseSync(path, { readOnly: true });
  let version = 0;
  try {
    version = Number(probe.prepare('PRAGMA user_version').get()?.['user_version'] ?? 0);
  } finally { probe.close(); rmSync(root, { recursive: true, force: true }); }
  assert.ok(version > 0, 'the store reports a schema version');

  // Only statements about the *current* version are checked. A changelog line such as "v12 added
  // `entry_versions`" is history and must keep naming v12, so the cue is what separates the two.
  const current = /(?:当前|目前|现在)[^。\n]{0,40}?schema[*\s]*(?:版本)?[*\s]*v(\d+)/gi;
  const files = ['README.md', 'docs/implementation.md', 'docs/sync.md', 'docs/status.md'];
  let stated = 0;
  for (const file of files) {
    for (const match of read(file).matchAll(current)) {
      stated += 1;
      assert.equal(Number(match[1]), version, `${file} calls v${match[1]} current, but the code creates v${version}`);
    }
  }
  assert.ok(stated > 0, 'at least one document states which schema version is current');

  // The README is the front door and must not carry a stale headline version.
  const readme = read('README.md');
  const headline = /schema[*\s]*(?:版本)?[*\s]*v(\d+)/i.exec(readme);
  assert.ok(headline, 'the README names a schema version');
  assert.equal(Number(headline[1]), version, 'the README headline version matches the code');
});

test('every API path the UI doc mentions is a real route', () => {
  const documented = [...read('docs/ui.md').matchAll(/`(\/v1\/[^`\s]+)`/g)]
    .map(match => match[1]!)
    // Drop a query string: `/v1/memories?query=` names the same route as `/v1/memories`.
    .map(path => path.split('?')[0]!)
    // Normalise the id placeholder: docs may write either the template or an example id.
    .map(path => path.replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, '/{memoryId}'))
    .map(path => path.replace(/\/\{caseId\}$/, '/{caseId}'));
  const known = new Set(Object.keys(openapi.paths));
  const unknown = [...new Set(documented)].filter(path => !known.has(path));
  assert.deepEqual(unknown, [], 'the UI doc must not document routes that do not exist');
});

test('the documented tab count matches the tab bar', async () => {
  // Reading the tab order from the source keeps this honest even if the doc is edited by hand.
  const panels = read('plugins/dsh-mnemo-weave/src/client/panels.tsx');
  const order = /export const TAB_ORDER: readonly Tab\[\] = \[([^\]]+)\]/.exec(panels)?.[1] ?? '';
  const tabs = order.split(',').map(entry => entry.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.equal(tabs.length, 6, 'the page has six page-level tabs');

  const zh = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  const text = read('docs/ui.md');
  const claim = [...text.matchAll(/([一二三四五六七八九十])个页签/g)].map(match => match[1]!);
  assert.ok(claim.length > 0, 'the UI doc states how many tabs there are');
  for (const numeral of claim) {
    assert.equal(zh.indexOf(numeral) + 1, tabs.length, `the doc says ${numeral} tabs but the page renders ${tabs.length}`);
  }

  // The acceptance checklist must cover every tab. A tab that exists but is never listed is a tab
  // nobody has agreed how to verify. The formal-memory page's views are checked with their own
  // labels, because they are tabs of that page rather than page-level entries.
  const i18n = read('plugins/dsh-mnemo-weave/src/client/i18n.ts');
  const acceptance = read('docs/host-acceptance.md');
  for (const tab of tabs) {
    const label = new RegExp(`'tabs\\.${tab}': '([^']+)'`).exec(i18n)?.[1];
    assert.ok(label, `the tab ${tab} has a label`);
    assert.ok(acceptance.includes(label!), `host-acceptance.md must list the "${label}" tab`);
  }
  const viewOrder = /export const MEMORY_VIEW_ORDER: readonly MemoryView\[\] = \[([^\]]+)\]/.exec(panels)?.[1] ?? '';
  const views = viewOrder.split(',').map(entry => entry.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.equal(views.length, 4, 'the formal-memory page has four views');
  for (const view of views) {
    const label = new RegExp(`'memory\\.tabs\\.${view}': '([^']+)'`).exec(i18n)?.[1];
    assert.ok(label, `the view ${view} has a label`);
    assert.ok(acceptance.includes(label!), `host-acceptance.md must list the "${label}" view`);
  }
});
