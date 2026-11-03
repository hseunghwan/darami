/**
 * Where things are in a wiki folder, as paths the Fs port takes. The only file that knows a path
 * shape, and the only one that makes a WikiPath. Pure: it builds strings and reads nothing.
 *
 * From dotoriwiki src/wiki/layout.ts `layout(root)`, minus the root: an Fs is already bound to its
 * folder, so there are no absolute paths. The filesystem primitives there become Fs methods, each
 * with the phase that first calls it; composeSystemPrompt moved to wiki.ts, beside the other reader.
 */

import { CONFIG_FILE } from './config';
import type { DomainName } from './types';

/**
 * A place in the wiki folder: relative to its root, `/`-separated, NFC, with no empty, `.`, or `..`
 * segment and no `\` or NUL. ROOT, `''`, is the folder itself. Every Fs call takes one, so an
 * adapter is never led outside the folder it was given.
 */
export type WikiPath = string & { readonly __brand: 'WikiPath' };

export const ROOT = '' as WikiPath;

const BAD_SEGMENT = /[\\\0]/;

/** `text` when it already follows the WikiPath rule, else null. For paths that were stored, not written by a person or a model. */
export function parseWikiPath(text: string): WikiPath | null {
  if (text === '') return ROOT;
  if (text !== text.normalize('NFC')) return null;
  return text.split('/').every((s) => s !== '' && s !== '.' && s !== '..' && !BAD_SEGMENT.test(s)) ? (text as WikiPath) : null;
}

/**
 * `target`, as written in a file or by a model, resolved against the folder `fromDir`: NFC, empty
 * and `.` segments dropped, `..` going up. null when it is absolute, holds `\` or NUL, or climbs
 * above the root.
 *
 *   resolvePath('스터디', '../_schema/공통규칙.md')  → '_schema/공통규칙.md'
 *   resolvePath('스터디', '../../x.md')              → null
 */
export function resolvePath(fromDir: WikiPath, target: string): WikiPath | null {
  if (target.startsWith('/') || BAD_SEGMENT.test(target)) return null;
  const out = fromDir === '' ? [] : fromDir.split('/');
  for (const s of target.normalize('NFC').split('/')) {
    if (s === '' || s === '.') continue;
    if (s !== '..') out.push(s);
    else if (out.pop() === undefined) return null;
  }
  return out.join('/') as WikiPath;
}

/** Arguments are already valid segments: a DomainName is checked by parseWikiConfig. */
const p = (s: string) => s as WikiPath;

/** The folder contract. P1 reads `config`, `rootSchema`, and `domainSchema`; the rest is the format P1 keeps. */
export const paths = {
  config: p(CONFIG_FILE),
  rootSchema: p('CLAUDE.md'),
  inbox: p('inbox'),
  rejected: p('inbox/.rejected'),
  answersInbox: (d: DomainName) => p(`inbox/answers/${d}`),
  domain: (d: DomainName) => p(d),
  /** <d>/CLAUDE.md: the domain's prose, which a declared domain must have. */
  domainSchema: (d: DomainName) => p(`${d}/CLAUDE.md`),
  raw: (d: DomainName) => p(`${d}/raw`),
  hold: (d: DomainName) => p(`${d}/hold`),
  wiki: (d: DomainName) => p(`${d}/wiki`),
  log: (d: DomainName) => p(`${d}/wiki/log.md`),
  index: (d: DomainName) => p(`${d}/wiki/index.md`),
  review: (d: DomainName) => p(`${d}/wiki/_review.md`),
  /** Photos as the phone sent them. */
  originals: p('_originals'),
  /** The 2048 px copies pages embed. */
  attachments: p('_attachments'),
} as const;
