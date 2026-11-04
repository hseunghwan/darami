/**
 * Article text from HTML: dotoriwiki's readableText, linkedom with Mozilla Readability and its
 * tidy, at dotoriwiki's pinned versions, so the same page gives the same sidecar text.
 *
 * It runs on the JS thread, which it blocks: 2.5 s for a 67 KB page on the emulator. So the parse
 * is bounded. Markup Readability drops before it scores anyway (comments, style, svg, and every
 * script but JSON-LD, which it reads for the title) goes first, and at most PARSE_MAX_CHARS of the
 * rest reaches linkedom, where an article's text starts.
 */

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { tidy } from '../core/sources';

export const PARSE_MAX_CHARS = 1_000_000;

const INERT = /<!--[\s\S]*?-->|<style\b[^>]*>[\s\S]*?<\/style\s*>|<svg\b[^>]*>[\s\S]*?<\/svg\s*>|<script\b([^>]*)>[\s\S]*?<\/script\s*>/gi;
const JSON_LD = /\btype\s*=\s*["']?application\/ld\+json/i;

export const stripInert = (html: string): string => html.replace(INERT, (m, scriptAttrs: string | undefined) => (scriptAttrs !== undefined && JSON_LD.test(scriptAttrs) ? m : ''));

export function boundedHtml(html: string): string {
  const s = stripInert(html);
  if (s.length <= PARSE_MAX_CHARS) return s;
  const cut = s.lastIndexOf('<', PARSE_MAX_CHARS);
  return s.slice(0, cut > 0 ? cut : PARSE_MAX_CHARS);
}

export function readableText(html: string): { readonly title: string; readonly text: string } | null {
  const { document } = parseHTML(boundedHtml(html));
  const article = new Readability(document as unknown as Document).parse();
  const text = tidy(article?.textContent ?? '');
  return text ? { title: (article?.title ?? '').trim(), text } : null;
}
