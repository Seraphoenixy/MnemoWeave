import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph, linkLabel } from '../../plugins/dsh-mnemo-weave/src/client/graph-layout.ts';
import type { UiGraph, UiGraphEdge } from '../../plugins/dsh-mnemo-weave/src/shared/contract.ts';

/**
 * The graph layout has to be a pure function of the graph.
 *
 * A force simulation would look alive but settle differently every render, so the same graph would
 * appear to change between visits and nothing about it could be asserted. These tests pin the
 * properties a reader relies on: stable coordinates, rings by hop, and everything inside bounds.
 */

const edge = (id: string, source: string, target: string, kind: 'Supersedes' | 'RelatedTo' = 'RelatedTo'): UiGraphEdge => ({
  relationId: id, kind, sourceMemoryId: source, targetMemoryId: target, reason: `why ${id}`, effectiveAt: '2026-11-10T00:00:00.000Z',
});

const node = (memoryId: string, importance?: number, category?: string) => ({
  memoryId, scope: 'global' as const, state: 'active' as const, publishedAt: '2026-11-10T00:00:00.000Z',
  ...(importance === undefined ? {} : { importance }),
  ...(category === undefined ? {} : { category }),
});

function graph(nodes: string[], edges: UiGraphEdge[], extra: { importance?: Record<string, number>; category?: Record<string, string> } = {}): UiGraph {
  return {
    nodes: nodes.map(id => node(id, extra.importance?.[id], extra.category?.[id])),
    edges,
    truncated: false,
  };
}

test('the same graph lays out identically twice', () => {
  const input = graph(['a', 'b', 'c', 'd'], [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'c', 'd')]);
  const first = layoutGraph(input);
  const second = layoutGraph(input);
  assert.deepEqual(second, first, 'no randomness: two runs produce the same drawing');
});

test('nodes sit on rings by hop distance from the most connected node', () => {
  // b is touched by two edges and is therefore the centre.
  const input = graph(['a', 'b', 'c'], [edge('e1', 'b', 'a'), edge('e2', 'b', 'c')]);
  const layout = layoutGraph(input);
  const byId = new Map(layout.nodes.map(item => [item.memoryId, item]));
  assert.equal(byId.get('b')?.hop, 0, 'the most connected node is the centre');
  assert.equal(byId.get('a')?.hop, 1);
  assert.equal(byId.get('c')?.hop, 1);
  // Both direct neighbours are the same distance from the centre, opposite each other.
  const centre = byId.get('b')!;
  const a = byId.get('a')!;
  const c = byId.get('c')!;
  assert.equal(Math.round(Math.hypot(a.x - centre.x, a.y - centre.y)), Math.round(Math.hypot(c.x - centre.x, c.y - centre.y)));
});

test('every coordinate is finite and inside the reported bounds', () => {
  const input = graph(['a', 'b', 'c', 'd', 'e'], [edge('e1', 'a', 'b'), edge('e2', 'a', 'c'), edge('e3', 'a', 'd'), edge('e4', 'd', 'e')], {
    importance: { a: 5, b: 1 },
  });
  const layout = layoutGraph(input);
  for (const item of layout.nodes) {
    assert.ok(Number.isFinite(item.x) && Number.isFinite(item.y), `finite coordinates for ${item.memoryId}`);
    assert.ok(item.x >= 0 && item.x <= layout.width, 'x stays inside the viewBox');
    assert.ok(item.y >= 0 && item.y <= layout.height, 'y stays inside the viewBox');
    assert.ok(item.radius > 0, 'a node always has a drawable radius');
  }
  // A recorded importance sizes the node; an absent one is not treated as the smallest.
  const byId = new Map(layout.nodes.map(item => [item.memoryId, item]));
  assert.ok(byId.get('a')!.radius > byId.get('b')!.radius, 'higher importance draws a bigger node');
  assert.equal(byId.get('c')!.radius, byId.get('e')!.radius, 'nodes without importance share the default size');
});

test('an isolated memory is drawn apart instead of being placed at the centre', () => {
  const input = graph(['a', 'b', 'lonely'], [edge('e1', 'a', 'b')]);
  const layout = layoutGraph(input);
  assert.deepEqual(layout.isolated, ['lonely'], 'a node with no relation is reported');
  const lonely = layout.nodes.find(item => item.memoryId === 'lonely')!;
  assert.ok(lonely.hop >= 1, 'it does not claim to be the centre');
});

test('links carry both endpoints and only drawable relations survive', () => {
  const input = graph(['a', 'b'], [edge('e1', 'a', 'b', 'Supersedes'), edge('self', 'a', 'a'), edge('dangling', 'a', 'missing')]);
  const layout = layoutGraph(input);
  assert.deepEqual(layout.links.map(link => link.relationId), ['e1'], 'self loops and dangling edges are not drawn');
  const link = layout.links[0]!;
  assert.ok(Number.isFinite(link.x1) && Number.isFinite(link.y1) && Number.isFinite(link.x2) && Number.isFinite(link.y2));
  assert.equal(linkLabel(link), 'supersedes');
  assert.equal(linkLabel({ kind: 'RelatedTo' }), '', 'a plain relation is not labelled as a supersede');
});

test('an empty graph reports a drawable empty canvas', () => {
  const layout = layoutGraph({ nodes: [], edges: [], truncated: false });
  assert.deepEqual(layout.nodes, []);
  assert.deepEqual(layout.links, []);
  assert.ok(layout.width > 0 && layout.height > 0, 'the viewBox is still usable');
});

test('a retired node is marked apart from the memories still served', () => {
  // A supersede edge points at a memory that is no longer active; the drawing has to show it as
  // history rather than as a current memory.
  const input = {
    nodes: [
      { memoryId: 'a', scope: 'global' as const, state: 'active' as const, publishedAt: '2026-11-10T00:00:00.000Z' },
      { memoryId: 'b', scope: 'global' as const, state: 'superseded' as const, publishedAt: '2026-11-09T00:00:00.000Z' },
    ],
    edges: [edge('e1', 'a', 'b', 'Supersedes')],
    truncated: false,
  };
  const layout = layoutGraph(input);
  const byId = new Map(layout.nodes.map(item => [item.memoryId, item]));
  assert.equal(byId.get('a')?.retired, false);
  assert.equal(byId.get('b')?.retired, true, 'a superseded memory is drawn as retired');
  assert.equal(layout.links.length, 1, 'the edge to the retired memory is still drawn');
});
