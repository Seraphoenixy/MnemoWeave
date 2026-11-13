import type { UiGraph, UiGraphEdge } from '../shared/contract.ts';

/**
 * Relation-graph layout, following the DSH memory graph.
 *
 * The reference implementation does not draw concentric rings: it seeds nodes into category
 * clusters and then relaxes them with a force pass, so connected memories sit near each other and
 * unrelated ones drift apart. That is what makes a dense graph readable, and rings cannot express
 * it. The pass is deterministic — seeded by a hash of the node id and cooled by a fixed schedule —
 * so the same graph draws the same way on every visit, which a randomised simulation would not.
 *
 * Positions live in a fixed drawing space; the caller maps that space into its viewBox.
 */

export const GRAPH_WIDTH = 930;
export const GRAPH_HEIGHT = 520;
const MARGIN_X = 58;
const MARGIN_Y = 58;
/** Cluster order: the drawing groups kinds the way the page lists them. */
const CATEGORY_ORDER = ['entity', 'preference', 'decision', 'fact', 'insight', 'context', 'general'];
const RELAX_ITERATIONS = 150;

export interface GraphPosition { x: number; y: number }
export type GraphPositions = Map<string, GraphPosition>;
export type GraphLayoutMode = 'natural' | 'uniform' | 'custom';

/**
 * Stable spread value for one id.
 *
 * The cluster seeds need a spread that does not change between renders. A hash gives that; a
 * random number would make the first frame jump every time the page reloads.
 */
function hash(value: string): number {
  let result = 2166136261;
  for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619);
  return result >>> 0;
}

export function clampGraphPosition(position: GraphPosition): GraphPosition {
  return {
    x: Math.min(GRAPH_WIDTH - MARGIN_X, Math.max(MARGIN_X, position.x)),
    y: Math.min(GRAPH_HEIGHT - MARGIN_Y, Math.max(MARGIN_Y, position.y)),
  };
}

/**
 * Category anchors on a ring, so several clusters do not all collapse onto the centre.
 *
 * A single category sits in the middle: spreading one cluster around a ring would only make the
 * drawing look like it is missing something.
 */
export function categoryAnchors(grouped: Map<string, unknown[]>): Map<string, GraphPosition> {
  const categories = [...grouped.keys()].sort((left, right) => {
    const leftIndex = CATEGORY_ORDER.indexOf(left);
    const rightIndex = CATEGORY_ORDER.indexOf(right);
    return (leftIndex < 0 ? CATEGORY_ORDER.length : leftIndex) - (rightIndex < 0 ? CATEGORY_ORDER.length : rightIndex);
  });
  const anchors = new Map<string, GraphPosition>();
  if (categories.length === 1) {
    anchors.set(categories[0]!, { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 });
    return anchors;
  }
  categories.forEach((category, index) => {
    const angle = -Math.PI / 2 + (index / categories.length) * Math.PI * 2;
    anchors.set(category, {
      x: GRAPH_WIDTH / 2 + Math.cos(angle) * Math.min(250, 115 + categories.length * 23),
      y: GRAPH_HEIGHT / 2 + Math.sin(angle) * Math.min(165, 78 + categories.length * 15),
    });
  });
  return anchors;
}

/**
 * Relax the seeded clusters into a readable arrangement.
 *
 * Three forces: repulsion keeps nodes from overlapping, springs pull connected nodes to a distance
 * that depends on the edge type (an entity link is tighter than a semantic one), and a weak pull
 * toward the category anchor keeps clusters from dissolving into each other.
 */
export function naturalGraphPositions(nodes: readonly UiGraphNode[], edges: readonly UiGraphEdge[]): GraphPositions {
  const positions: GraphPositions = new Map();
  const grouped = new Map<string, UiGraphNode[]>();
  for (const node of nodes) {
    const category = node.category ?? 'general';
    grouped.set(category, [...(grouped.get(category) ?? []), node]);
  }
  const anchors = categoryAnchors(grouped);
  for (const [category, items] of grouped) {
    const anchor = anchors.get(category) ?? { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 };
    items.forEach((node, index) => {
      const seed = hash(nodeKey(node));
      // The golden angle spreads successive nodes without ever repeating a direction.
      const angle = index * 2.399963 + ((seed % 37) / 37) * 0.4;
      const radius = items.length === 1 ? 0 : 24 + Math.sqrt(index + 1) * 35;
      positions.set(nodeKey(node), clampGraphPosition({ x: anchor.x + Math.cos(angle) * radius, y: anchor.y + Math.sin(angle) * radius }));
    });
  }

  const velocities = new Map(nodes.map(node => [nodeKey(node), { x: 0, y: 0 }]));
  const visibleIds = new Set(nodes.map(nodeKey));
  const visibleEdges = edges.filter(edge => visibleIds.has(edge.sourceMemoryId) && visibleIds.has(edge.targetMemoryId));
  for (let iteration = 0; iteration < RELAX_ITERATIONS; iteration += 1) {
    const cooling = 1 - iteration / 180;
    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      const left = nodes[leftIndex]!;
      const leftPosition = positions.get(nodeKey(left))!;
      const leftVelocity = velocities.get(nodeKey(left))!;
      for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
        const right = nodes[rightIndex]!;
        const rightPosition = positions.get(nodeKey(right))!;
        const rightVelocity = velocities.get(nodeKey(right))!;
        let dx = leftPosition.x - rightPosition.x;
        let dy = leftPosition.y - rightPosition.y;
        // Coincident points have no direction to push apart; derive one from the ids so the
        // result stays deterministic instead of depending on iteration order.
        if (dx === 0 && dy === 0) {
          dx = ((hash(nodeKey(left)) % 13) - 6) || 1;
          dy = ((hash(nodeKey(right)) % 11) - 5) || -1;
        }
        const distanceSquared = Math.max(100, dx * dx + dy * dy);
        const distance = Math.sqrt(distanceSquared);
        const repulsion = Math.min(9, 18000 / distanceSquared) * cooling;
        const collision = distance < 66 ? (66 - distance) * 0.08 : 0;
        const force = repulsion + collision;
        const forceX = (dx / distance) * force;
        const forceY = (dy / distance) * force;
        leftVelocity.x += forceX; leftVelocity.y += forceY;
        rightVelocity.x -= forceX; rightVelocity.y -= forceY;
      }
    }
    for (const edge of visibleEdges) {
      const source = positions.get(edge.sourceMemoryId)!;
      const target = positions.get(edge.targetMemoryId)!;
      const sourceVelocity = velocities.get(edge.sourceMemoryId)!;
      const targetVelocity = velocities.get(edge.targetMemoryId)!;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      // A sparse graph needs longer edges to fill the canvas; a dense one needs them short.
      const sparseScale = nodes.length <= 3 ? 2 : nodes.length <= 8 ? 1.45 : 1;
      const desired = desiredEdgeLength(edge.kind) * sparseScale;
      const spring = (distance - desired) * 0.018 * cooling;
      const forceX = (dx / distance) * spring;
      const forceY = (dy / distance) * spring;
      sourceVelocity.x += forceX; sourceVelocity.y += forceY;
      targetVelocity.x -= forceX; targetVelocity.y -= forceY;
    }
    for (const node of nodes) {
      const key = nodeKey(node);
      const position = positions.get(key)!;
      const velocity = velocities.get(key)!;
      const anchor = anchors.get(node.category ?? 'general') ?? { x: GRAPH_WIDTH / 2, y: GRAPH_HEIGHT / 2 };
      velocity.x += (anchor.x - position.x) * 0.0035 * cooling + (GRAPH_WIDTH / 2 - position.x) * 0.0008;
      velocity.y += (anchor.y - position.y) * 0.0035 * cooling + (GRAPH_HEIGHT / 2 - position.y) * 0.0008;
      velocity.x = Math.max(-12, Math.min(12, velocity.x * 0.76));
      velocity.y = Math.max(-12, Math.min(12, velocity.y * 0.76));
      positions.set(key, clampGraphPosition({ x: position.x + velocity.x, y: position.y + velocity.y }));
    }
  }
  return positions;
}

/** Resting length per relation kind: closer for a carried entity, wider for a loose association. */
function desiredEdgeLength(kind: UiGraphEdge['kind']): number {
  if (kind === 'Conflicts') return 138;
  if (kind === 'Supersedes') return 94;
  return 106;
}

/** Even grid, used by the uniform layout button. */
export function uniformGraphPositions(nodes: readonly UiGraphNode[]): GraphPositions {
  const positions: GraphPositions = new Map();
  const ordered = [...nodes].sort((left, right) => {
    const difference = CATEGORY_ORDER.indexOf(left.category ?? 'general') - CATEGORY_ORDER.indexOf(right.category ?? 'general');
    return difference === 0 ? left.memoryId.localeCompare(right.memoryId) : difference;
  });
  const columns = Math.max(1, Math.ceil(Math.sqrt(ordered.length * 1.65)));
  const rows = Math.max(1, Math.ceil(ordered.length / columns));
  const cellWidth = (GRAPH_WIDTH - MARGIN_X * 2) / columns;
  const cellHeight = (GRAPH_HEIGHT - MARGIN_Y * 2) / rows;
  ordered.forEach((node, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const rowLength = Math.min(columns, ordered.length - row * columns);
    const rowOffset = (columns - rowLength) * cellWidth / 2;
    positions.set(node.memoryId, {
      x: MARGIN_X + rowOffset + cellWidth * (column + 0.5),
      y: MARGIN_Y + cellHeight * (row + 0.5),
    });
  });
  return positions;
}

/** The id a node is positioned by. Entity nodes carry no memory id, so theirs is derived. */
export function nodeKey(node: UiGraphNode): string {
  return node.memoryId;
}

export interface UiGraphNode {
  memoryId: string;
  state: 'active' | 'superseded' | 'unverified';
  publishedAt: string;
  category?: string;
  importance?: number;
}

/** Edge label worth drawing: a supersede changes what is served, a relation does not. */
export function linkLabel(edge: Pick<UiGraphEdge, 'kind'>): string {
  if (edge.kind === 'Supersedes') return 'supersedes';
  if (edge.kind === 'Conflicts') return 'conflicts';
  return '';
}
