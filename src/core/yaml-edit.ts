/**
 * Edits YAML text through the yaml Document API and keeps every byte the edit did not touch.
 *
 * yaml's toString normalizes hand formatting: a comment after a map key moves to its own line, and
 * every indent follows one width. So the document is rendered twice with the same options, before
 * and after the change, and only the lines that differ between the two renders are merged onto the
 * original text. That is a three-way line merge with the render before as the base. Where the
 * original's own formatting and the change touch the same lines, those lines take yaml's form.
 *
 * The merged text is kept only when it renders exactly as the changed document does, so it holds
 * the same data and the same comments. Otherwise the change comes back as yaml's own render of the
 * whole file, reformatted but complete.
 */

import { parseDocument, type Document, type ToStringOptions } from 'yaml';

const BOM = '\uFEFF';

/** `mutate` changes the parsed document in place. `text` must parse with no errors. */
export function editYamlText(text: string, mutate: (doc: Document) => void): string {
  const bom = text.startsWith(BOM);
  const unmarked = bom ? text.slice(1) : text;
  const crlf = unmarked.includes('\r\n') && !/(^|[^\r])\n/.test(unmarked);
  const body = crlf ? unmarked.replaceAll('\r\n', '\n') : unmarked;

  const opts: ToStringOptions = { lineWidth: 0, indent: indentOf(body) };
  const base = parseDocument(body).toString(opts);
  const doc = parseDocument(body);
  mutate(doc);
  const theirs = doc.toString(opts);

  const merged = merge3(base.split('\n'), body.split('\n'), theirs.split('\n')).join('\n');
  const check = parseDocument(merged);
  const out = check.errors.length === 0 && check.toString(opts) === theirs ? merged : theirs;
  return (bom ? BOM : '') + (crlf ? out.replaceAll('\n', '\r\n') : out);
}

/** The file's own indent: the column of its first indented line, so a 4-space file stays 4-space. */
function indentOf(body: string): number {
  const n = /^( +)[^\s#]/m.exec(body)?.[1]?.length ?? 2;
  return Math.max(n, 2);
}

/** Lines [start, end) of the base replaced by `lines`. */
type Hunk = { readonly start: number; readonly end: number; readonly lines: readonly string[] };

/** The hunks that turn a into b, from a longest common subsequence of lines. The file is a few hundred lines at most. */
function lineHunks(a: readonly string[], b: readonly string[]): Hunk[] {
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const out: Hunk[] = [];
  let cur: { start: number; end: number; lines: string[] } | null = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      if (cur) out.push(cur);
      cur = null;
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      cur ??= { start: i, end: i, lines: [] };
      cur.lines.push(b[j++]!);
    } else {
      cur ??= { start: i, end: i, lines: [] };
      cur.end = ++i;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * base→ours and base→theirs applied together. Hunks whose base spans overlap, or that insert at the
 * same line, form a cluster; a cluster with hunks from both sides takes theirs over its span.
 */
function merge3(base: readonly string[], ours: readonly string[], theirs: readonly string[]): string[] {
  const hunks = [...lineHunks(base, ours).map((h) => ({ ...h, theirs: false })), ...lineHunks(base, theirs).map((h) => ({ ...h, theirs: true }))].sort(
    (x, y) => x.start - y.start || x.end - y.end,
  );
  const out: string[] = [];
  let at = 0;
  for (let k = 0; k < hunks.length; ) {
    const start = hunks[k]!.start;
    let end = hunks[k]!.end;
    let next = k + 1;
    while (next < hunks.length && (hunks[next]!.start < end || hunks[next]!.start === start)) end = Math.max(end, hunks[next++]!.end);
    const cluster = hunks.slice(k, next);
    const mixed = cluster.some((h) => h.theirs) && cluster.some((h) => !h.theirs);
    out.push(...base.slice(at, start));
    let p = start;
    for (const h of mixed ? cluster.filter((c) => c.theirs) : cluster) {
      out.push(...base.slice(p, h.start), ...h.lines);
      p = h.end;
    }
    out.push(...base.slice(p, end));
    at = end;
    k = next;
  }
  out.push(...base.slice(at));
  return out;
}
