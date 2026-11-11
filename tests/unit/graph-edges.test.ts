import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawableEdges } from '../../apps/server/src/config.ts';

/**
 * The graph may only contain edges a renderer can draw.
 *
 * Relations are created by the candidate publication path, so a fixture would have to run the
 * whole review pipeline to produce one. The filter is therefore a pure function with its own
 * test: dangling edges and self-loops are what a renderer would otherwise crash on, or silently
 * draw as a line to nowhere.
 */

const edge = (id: string, sourceMemoryId: string, targetMemoryId: string, kind = 'Supersedes') => ({
  id, kind, sourceMemoryId, targetMemoryId, effectiveAt: '2026-11-10T00:00:00.000Z', reason: `why ${id}`,
});

test('edges survive only when both endpoints are nodes and are not the same node', () => {
  const nodes = ['a', 'b', 'c'];
  const kept = drawableEdges(nodes, [
    edge('keep', 'a', 'b'),
    edge('dangling-target', 'a', 'gone'),
    edge('dangling-source', 'gone', 'b'),
    edge('self', 'c', 'c'),
  ]);
  assert.deepEqual(kept.map(item => item.relationId), ['keep'], 'everything undrawable is dropped');
  assert.deepEqual(kept[0], {
    relationId: 'keep', kind: 'Supersedes', sourceMemoryId: 'a', targetMemoryId: 'b',
    reason: 'why keep', effectiveAt: '2026-11-10T00:00:00.000Z',
  });
});

test('a relation kind the contract does not name is reported as RelatedTo, never as Supersedes', () => {
  // The catalog stores kinds the wire contract does not enumerate. Treating an unknown kind as
  // Supersedes would claim a memory replaced another one, which is a stronger statement than the
  // data supports.
  const kept = drawableEdges(['a', 'b'], [edge('x', 'a', 'b', 'semantic'), edge('y', 'a', 'b', 'RelatedTo')]);
  assert.deepEqual(kept.map(item => item.kind), ['RelatedTo', 'RelatedTo']);
});

test('a truncated graph drops exactly the edges that would dangle', () => {
  const edges = [edge('ab', 'a', 'b'), edge('bc', 'b', 'c')];
  assert.equal(drawableEdges(['a', 'b', 'c'], edges).length, 2);
  assert.deepEqual(drawableEdges(['a'], edges), [], 'keeping only one node drops every edge');
  assert.deepEqual(drawableEdges(['a', 'b'], edges).map(item => item.relationId), ['ab']);
});

test('a conflict is drawn as a conflict, not folded into another kind', () => {
  // A coexist resolution leaves two live memories that disagree. Calling that "related" would hide
  // the disagreement, and calling it a supersede would be false.
  const kept = drawableEdges(['a', 'b'], [edge('c1', 'a', 'b', 'Conflicts')]);
  assert.deepEqual(kept.map(item => item.kind), ['Conflicts']);
});
