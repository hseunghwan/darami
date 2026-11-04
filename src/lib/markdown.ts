import { linkTarget } from '../core/pages';

/**
 * Just enough Markdown for chat answers and wiki pages: bold, wikilinks, embeds, headings and
 * bullets. Anything else stays plain text. A link keeps `target`, the link as extractWikilinks
 * normalizes it, so it is the key of an answer's or a page's `links`.
 */
export type Span =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'bold'; readonly text: string }
  | { readonly kind: 'link'; readonly text: string; readonly target: string }
  /** `![[x.jpg]]`: `text` is the file name. */
  | { readonly kind: 'embed'; readonly text: string };

/** "스터디/wiki/개념/RAG" shows as "개념/RAG"; a bare page name is already relative to the asked domain. */
export const pageLabel = (ref: string): string => ref.split('/wiki/').at(-1) ?? ref;

const INLINE = /\*\*(.+?)\*\*|(!?)\[\[([^\]]+)\]\]/g;

function inline(line: string): Span[] {
  const out: Span[] = [];
  let last = 0;
  for (const m of line.matchAll(INLINE)) {
    if (m.index > last) out.push({ kind: 'text', text: line.slice(last, m.index) });
    const target = m[3] === undefined ? '' : linkTarget(m[3]);
    out.push(m[1] !== undefined ? { kind: 'bold', text: m[1] } : m[2] ? { kind: 'embed', text: target } : { kind: 'link', text: pageLabel(target), target });
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ kind: 'text', text: line.slice(last) });
  return out;
}

export function markdownSpans(text: string): Span[] {
  return text.split('\n').flatMap((line, i) => {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
    const spans: Span[] = heading ? [{ kind: 'bold', text: heading[1]! }] : bullet ? [{ kind: 'text', text: `${bullet[1]}• ` }, ...inline(bullet[2]!)] : inline(line);
    return i === 0 ? spans : [{ kind: 'text' as const, text: '\n' }, ...spans];
  });
}
