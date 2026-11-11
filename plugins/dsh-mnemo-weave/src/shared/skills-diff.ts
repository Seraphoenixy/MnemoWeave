/**
 * Line diff for the skill version view. Pure and shared: the Host only supplies both texts.
 */
export interface DiffLine {
  kind: 'same' | 'add' | 'remove';
  text: string;
}

const MAX_LINES = 1500;

/** Above the cap the page shows a coarse replacement rather than an unusable 4M-cell table. */
export function diffLines(left: string, right: string): DiffLine[] {
  const a = left.split(/\r?\n/);
  const b = right.split(/\r?\n/);
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [
      ...a.map(text => ({ kind: 'remove' as const, text })),
      ...b.map(text => ({ kind: 'add' as const, text })),
    ];
  }
  const width = b.length + 1;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j]
        ? table[(i + 1) * width + j + 1]! + 1
        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { lines.push({ kind: 'same', text: a[i]! }); i += 1; j += 1; continue; }
    if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) { lines.push({ kind: 'remove', text: a[i]! }); i += 1; }
    else { lines.push({ kind: 'add', text: b[j]! }); j += 1; }
  }
  while (i < a.length) { lines.push({ kind: 'remove', text: a[i]! }); i += 1; }
  while (j < b.length) { lines.push({ kind: 'add', text: b[j]! }); j += 1; }
  return lines;
}

export function diffSummary(lines: readonly DiffLine[]): { added: number; removed: number } {
  return {
    added: lines.filter(line => line.kind === 'add').length,
    removed: lines.filter(line => line.kind === 'remove').length,
  };
}
