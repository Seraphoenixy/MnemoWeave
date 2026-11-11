import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, diffSummary } from '../../plugins/dsh-mnemo-weave/src/shared/skills-diff.ts';

test('the line diff marks only the changed lines and keeps both sides in order', () => {
  const lines = diffLines('one\ntwo\nthree\n', 'one\nTWO\nthree\nfour\n');
  assert.deepEqual(lines, [
    { kind: 'same', text: 'one' },
    { kind: 'remove', text: 'two' },
    { kind: 'add', text: 'TWO' },
    { kind: 'same', text: 'three' },
    { kind: 'add', text: 'four' },
    { kind: 'same', text: '' },
  ]);
  assert.deepEqual(diffSummary(lines), { added: 2, removed: 1 });
});

test('an unchanged text has no added or removed lines', () => {
  const lines = diffLines('same\n', 'same\n');
  assert.deepEqual(diffSummary(lines), { added: 0, removed: 0 });
  assert.deepEqual(diffLines('', ''), [{ kind: 'same', text: '' }]);
});

test('an oversized file falls back to a coarse replacement instead of a huge table', () => {
  const big = Array.from({ length: 1600 }, (_, index) => `line ${index}`).join('\n');
  const lines = diffLines(big, 'short');
  assert.equal(lines.filter(line => line.kind === 'remove').length, 1600);
  assert.deepEqual(lines.at(-1), { kind: 'add', text: 'short' });
});
