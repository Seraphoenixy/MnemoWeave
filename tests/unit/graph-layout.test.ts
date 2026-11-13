import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRAPH_HEIGHT, GRAPH_WIDTH, clampGraphPosition, linkLabel, naturalGraphPositions, uniformGraphPositions } from '../../plugins/dsh-mnemo-weave/src/client/graph-layout.ts';
import type { UiGraphEdge, UiGraphNode } from '../../plugins/dsh-mnemo-weave/src/shared/contract.ts';

/**
 * The layout has to be a pure function of the graph.
 *
 * The reference implementation relaxes a seeded arrangement with a force pass instead of placing
 * nodes on rings. That reads far better on a dense graph — connected memories end up near each
 * other — but a force pass is normally run-to-run random. These tests pin the properties that keep
 * it usable: the same input produces the same drawing, everything stays inside the canvas, and a
 * connected pair sits closer together than an unconnected one.
 */

const edge = (id: string, source: string, target: string, kind: 'Supersedes' | 'RelatedTo' | 'Conflicts' | 'Entity' = 'RelatedTo'): UiGraphEdge => ({
  relationId: id, kind, sourceMemoryId: source, targetMemoryId: target, reason: `why ${id}`, effectiveAt: '2026-11-10T00:00:00.000Z',
});

const node = (memoryId: string, category?: string): UiGraphNode => ({
  memoryId, state: 'active' as const, publishedAt: '2026-11-10T00:00:00.000Z',
  ...(category === undefined ? {} : { category }),
});

test('the same graph lays out identically twice', () => {
  const nodes = [node('a'), node('b'), node('c'), node('d')];
  const edges = [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('e3', 'c', 'd')];
  const first = naturalGraphPositions(nodes, edges);
  const second = naturalGraphPositions(nodes, edges);
  // No randomness in the seed or the relaxation: a graph must not appear to rearrange itself
  // between visits.
  assert.deepEqual([...second], [...first]);
});

test('every position is finite and inside the canvas', () => {
  const nodes = [node('a', 'decision'), node('b', 'decision'), node('c', 'fact'), node('d', 'fact'), node('e')];
  const edges = [edge('e1', 'a', 'b'), edge('e2', 'a', 'c'), edge('e3', 'a', 'd'), edge('e4', 'd', 'e')];
  const positions = naturalGraphPositions(nodes, edges);
  for (const [id, position] of positions) {
    assert.ok(Number.isFinite(position.x) && Number.isFinite(position.y), `finite coordinates for ${id}`);
    assert.ok(position.x >= 0 && position.x <= GRAPH_WIDTH, `x inside the canvas for ${id}`);
    assert.ok(position.y >= 0 && position.y <= GRAPH_HEIGHT, `y inside the canvas for ${id}`);
  }
});

test('clamping keeps a dragged node on the canvas', () => {
  assert.deepEqual(clampGraphPosition({ x: -500, y: -500 }), { x: 58, y: 58 });
  assert.deepEqual(clampGraphPosition({ x: 50_000, y: 50_000 }), { x: GRAPH_WIDTH - 58, y: GRAPH_HEIGHT - 58 });
  const inside = { x: 400, y: 300 };
  assert.deepEqual(clampGraphPosition(inside), inside, 'a position already inside is unchanged');
});

test('the uniform layout fills the canvas without overlapping cells', () => {
  const nodes = [node('a'), node('b'), node('c'), node('d'), node('e')];
  const positions = uniformGraphPositions(nodes);
  assert.equal(positions.size, nodes.length);
  const places = [...positions.values()].map(position => `${Math.round(position.x)},${Math.round(position.y)}`);
  assert.equal(new Set(places).size, nodes.length, 'no two nodes share a cell');
  for (const position of positions.values()) {
    assert.ok(position.x > 0 && position.x < GRAPH_WIDTH);
    assert.ok(position.y > 0 && position.y < GRAPH_HEIGHT);
  }
});

test('a connected pair ends up closer than an unconnected one', () => {
  // This is the property rings could not express and the reason for the force pass: the drawing
  // has to show what belongs together.
  const nodes = [node('a', 'fact'), node('b', 'fact'), node('lonely', 'fact')];
  const positions = naturalGraphPositions(nodes, [edge('e1', 'a', 'b')]);
  const distance = (left: string, right: string): number => {
    const first = positions.get(left)!;
    const second = positions.get(right)!;
    return Math.hypot(first.x - second.x, first.y - second.y);
  };
  assert.ok(distance('a', 'b') < distance('a', 'lonely'), 'linked memories are drawn nearer than unrelated ones');
});

test('an empty graph produces no positions rather than throwing', () => {
  assert.equal(naturalGraphPositions([], []).size, 0);
  assert.equal(uniformGraphPositions([]).size, 0);
});

test('an entity edge is labelled but a plain relation is not called a supersede', () => {
  assert.equal(linkLabel({ kind: 'Supersedes' }), 'supersedes');
  assert.equal(linkLabel({ kind: 'Conflicts' }), 'conflicts');
  assert.equal(linkLabel({ kind: 'RelatedTo' }), '', 'a plain relation is not labelled as a supersede');
  assert.equal(linkLabel({ kind: 'Entity' }), '', 'a shared entity is not a decision about content');
});
