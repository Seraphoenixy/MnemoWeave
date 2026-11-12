import type { UiGraph, UiGraphEdge } from '../shared/contract.ts';

/**
 * Deterministic layout for the relation graph.
 *
 * No physics simulation: a force layout would settle differently on every render, so the same
 * graph would look like it changed between visits, and a test could not assert anything about it.
 * This places nodes on concentric rings by hop distance from a chosen focus — the arrangement is a
 * pure function of the input, which is both predictable to look at and cheap to verify.
 */

export interface LayoutNode {
  memoryId: string;
  /** Centre in the layout's own coordinate space. */
  x: number;
  y: number;
  /** 0 for the focus, 1 for its direct neighbours, and so on. */
  hop: number;
  /** Circle radius, driven by importance when the revision recorded one. */
  radius: number;
  /** A retired node is drawn apart: it is reachable history, not a current memory. */
  retired: boolean;
  category?: string;
}

export interface LayoutLink {
  relationId: string;
  kind: 'Supersedes' | 'RelatedTo' | 'Conflicts';
  sourceId: string;
  targetId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface GraphLayout {
  nodes: LayoutNode[];
  links: LayoutLink[];
  /** Total extent, so the caller can size its viewBox without guessing. */
  width: number;
  height: number;
  /** Nodes with no relation at all: placed on the outermost ring and called out separately. */
  isolated: string[];
}

export interface LayoutOptions {
  /** Prefer this memory as the centre; otherwise the most connected node is used. */
  focusId?: string;
  /** Distance between rings, in layout units. */
  ringGap?: number;
  /** Space around the drawing. */
  padding?: number;
}

/**
 * Choose the centre.
 *
 * Degree first so the densest part of the graph lands in the middle, then memoryId so two nodes
 * with the same degree cannot swap places between renders.
 */
function chooseFocus(nodes: readonly string[], edges: readonly { sourceMemoryId: string; targetMemoryId: string }[]): string | null {
  if (nodes.length === 0) return null;
  const degree = new Map<string, number>(nodes.map(id => [id, 0]));
  for (const edge of edges) {
    if (edge.sourceMemoryId !== edge.targetMemoryId) {
      degree.set(edge.sourceMemoryId, (degree.get(edge.sourceMemoryId) ?? 0) + 1);
      degree.set(edge.targetMemoryId, (degree.get(edge.targetMemoryId) ?? 0) + 1);
    }
  }
  return [...nodes].sort((left, right) => {
    const byDegree = (degree.get(right) ?? 0) - (degree.get(left) ?? 0);
    return byDegree !== 0 ? byDegree : left < right ? -1 : left > right ? 1 : 0;
  })[0] ?? null;
}

function radiusFor(importance: number | undefined): number {
  // Absent importance is not "0": it gets the default size rather than the smallest one.
  return importance === undefined ? 9 : 6 + importance * 1.4;
}

export function layoutGraph(graph: UiGraph, options: LayoutOptions = {}): GraphLayout {
  const ringGap = options.ringGap ?? 120;
  const padding = options.padding ?? 60;
  const ids = graph.nodes.map(node => node.memoryId);
  const byId = new Map(graph.nodes.map(node => [node.memoryId, node]));
  if (ids.length === 0) return { nodes: [], links: [], width: padding * 2, height: padding * 2, isolated: [] };

  const adjacency = new Map<string, string[]>(ids.map(id => [id, []]));
  for (const edge of graph.edges) {
    if (edge.sourceMemoryId === edge.targetMemoryId) continue;
    adjacency.get(edge.sourceMemoryId)?.push(edge.targetMemoryId);
    adjacency.get(edge.targetMemoryId)?.push(edge.sourceMemoryId);
  }
  const focus = options.focusId !== undefined && byId.has(options.focusId) ? options.focusId : chooseFocus(ids, graph.edges);
  // A focus that is not in the graph would otherwise leave every node at hop 0.
  const centre = focus ?? ids[0]!;

  // Breadth-first hop distance from the focus.
  const hop = new Map<string, number>([[centre, 0]]);
  const queue = [centre];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const neighbour of adjacency.get(current) ?? []) {
      if (hop.has(neighbour)) continue;
      hop.set(neighbour, (hop.get(current) ?? 0) + 1);
      queue.push(neighbour);
    }
  }
  // Anything unreachable has no relation at all; it is drawn on its own ring rather than at the
  // centre, so "isolated" stays visually distinct from "central".
  const isolated = ids.filter(id => !hop.has(id)).sort();
  const isolationHop = isolated.length === 0 ? 0 : Math.max(0, ...hop.values()) + 1;

  const rings = new Map<number, string[]>();
  for (const id of ids) {
    const level = hop.get(id) ?? isolationHop;
    const ring = rings.get(level) ?? [];
    ring.push(id);
    rings.set(level, ring);
  }
  // Sorting inside a ring by id keeps the drawing identical run to run.
  for (const ring of rings.values()) ring.sort();

  const maxHop = Math.max(...rings.keys());
  // The drawing is symmetric around the centre, so one measurement describes both axes.
  const half = maxHop * ringGap;
  const centrePoint = half + padding;
  const placed: LayoutNode[] = [];
  for (const [level, ring] of [...rings].sort((left, right) => left[0] - right[0])) {
    if (level === 0) {
      for (const id of ring) {
        const node = byId.get(id)!;
        placed.push({
          memoryId: id, x: centrePoint, y: centrePoint, hop: 0, radius: radiusFor(node.importance), retired: node.state !== 'active',
          ...(node.category === undefined ? {} : { category: node.category }),
        });
      }
      continue;
    }
    const radius = level * ringGap;
    ring.forEach((id, index) => {
      // Even spacing, starting at the top so the first node of the biggest ring is at 12 o'clock.
      const angle = (index / ring.length) * Math.PI * 2 - Math.PI / 2;
      const node = byId.get(id)!;
      placed.push({
        memoryId: id,
        x: centrePoint + Math.cos(angle) * radius,
        y: centrePoint + Math.sin(angle) * radius,
        hop: level,
        radius: radiusFor(node.importance),
        retired: node.state !== 'active',
        ...(node.category === undefined ? {} : { category: node.category }),
      });
    });
  }

  const position = new Map(placed.map(node => [node.memoryId, node]));
  const links: LayoutLink[] = [];
  for (const edge of graph.edges) {
    const source = position.get(edge.sourceMemoryId);
    const target = position.get(edge.targetMemoryId);
    // The Server already excludes undrawable edges; skipping again keeps the renderer total.
    if (source === undefined || target === undefined || edge.sourceMemoryId === edge.targetMemoryId) continue;
    links.push({
      relationId: edge.relationId, kind: edge.kind,
      sourceId: edge.sourceMemoryId, targetId: edge.targetMemoryId,
      x1: source.x, y1: source.y, x2: target.x, y2: target.y,
    });
  }

  const size = centrePoint * 2;
  return {
    nodes: placed,
    links,
    width: size,
    height: size,
    isolated,
  };
}

/** Edge label worth drawing: a supersede changes what is served, a relation does not. */
export function linkLabel(edge: Pick<UiGraphEdge, 'kind'>): string {
  if (edge.kind === 'Supersedes') return 'supersedes';
  if (edge.kind === 'Conflicts') return 'conflicts';
  return '';
}
