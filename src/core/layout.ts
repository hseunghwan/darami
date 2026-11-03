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

/**
 * What an ingest job in `domain` may do with a path its model named. Models name paths relative to
 * the domain folder, as dotoriwiki's agents did from it as their cwd: `raw/<id>.md`, `wiki/RAG.md`,
 * `../일상/wiki/ME.md`.
 *
 *   page      a `.md` under <d>/wiki/ with no dot segment, other than the three below: the model writes it
 *   review    <d>/wiki/_review.md: the model may only add to its end
 *   server    <d>/wiki/index.md and log.md: the model reads them, the engine writes them
 *   readable  <d>/CLAUDE.md, <d>/raw/**, every declared domain's wiki/**, CLAUDE.md, dotoriwiki.yaml, _schema/**
 *   outside   anything else, and what is not a path (absolute, `\`, NUL, above the root): `path` is null then
 *
 * The three names are matched ignoring case, because Android's storage folds case and `wiki/LOG.md`
 * would otherwise be a page there that overwrites the ledger.
 */
export type JobPlace =
  | { readonly kind: 'page' | 'review' | 'server' | 'readable'; readonly path: WikiPath }
  | { readonly kind: 'outside'; readonly path: WikiPath | null };

const SERVER_FILES = ['index.md', 'log.md'];

export function placeForJob(domain: DomainName, declared: readonly DomainName[], target: string): JobPlace {
  const path = resolvePath(paths.domain(domain), target);
  return path === null ? { kind: 'outside', path: null } : placeOf(domain, declared, path);
}

/** placeForJob for a path already resolved, such as one listTree returned. */
export function placeOf(domain: DomainName, declared: readonly DomainName[], path: WikiPath): JobPlace {
  if (path === ROOT || path.split('/').some((s) => s.startsWith('.'))) return { kind: 'outside', path };
  const wiki = `${domain}/wiki/`;
  if (path.startsWith(wiki)) {
    const under = path.slice(wiki.length);
    const folded = under.toLowerCase();
    if (SERVER_FILES.includes(folded)) return { kind: 'server', path };
    if (folded === '_review.md') return { kind: 'review', path };
    return folded.endsWith('.md') ? { kind: 'page', path } : { kind: 'outside', path };
  }
  const [top, second, ...rest] = path.split('/');
  const readable =
    path === paths.domainSchema(domain) ||
    (top === domain && second === 'raw' && rest.length > 0) ||
    (declared.includes(top as DomainName) && second === 'wiki' && rest.length > 0) ||
    path === paths.rootSchema ||
    path === paths.config ||
    (top === '_schema' && second !== undefined);
  return { kind: readable ? 'readable' : 'outside', path };
}

/** `path` as the job's model names it: relative to the domain folder, `../` for another folder. */
export const shownPath = (domain: DomainName, path: WikiPath): string => (path.startsWith(`${domain}/`) ? path.slice(domain.length + 1) : `../${path}`);

/** A folder that holds memo files. `domain` is the path segment as written, not checked against the config. */
export type MemoSpot = { readonly kind: 'inbox' } | { readonly kind: 'raw' | 'hold'; readonly domain: string };

/** `inbox`, `<d>/raw`, or `<d>/hold`; null for anything else, `inbox/answers/<d>` and `inbox/.rejected` included. */
export function memoDirOf(dir: WikiPath): MemoSpot | null {
  if (dir === paths.inbox) return { kind: 'inbox' };
  const [domain, sub, ...rest] = dir.split('/');
  if (rest.length > 0 || !domain || domain.startsWith('.') || domain === paths.inbox) return null;
  return sub === 'raw' || sub === 'hold' ? { kind: sub, domain } : null;
}

/** What a write to `path` changes for the memo screens: a name in a memo folder, or a domain's ledger. */
export type Touched = { readonly kind: 'memo'; readonly dir: WikiPath; readonly name: string } | { readonly kind: 'ledger' };

export function touchedBy(path: WikiPath): Touched | null {
  const cut = path.lastIndexOf('/');
  if (cut < 0) return null;
  const dir = path.slice(0, cut) as WikiPath;
  if (memoDirOf(dir)) return { kind: 'memo', dir, name: path.slice(cut + 1) };
  const [domain, wiki, log, ...rest] = path.split('/');
  return domain && !domain.startsWith('.') && wiki === 'wiki' && log === 'log.md' && rest.length === 0 ? { kind: 'ledger' } : null;
}
