/**
 * The Workspace of agent/loop.ts over a job's transaction: the only way a model touches files.
 * Scope is core/layout placeForJob; every write goes through the journal. Reads come from the folder
 * itself, not from what the job wrote, so the reread rule sees a second writer such as Obsidian.
 *
 * Beside it, chatReader: a chat question's Reader, over the committed folder and nothing that writes.
 */

import { linkRef } from '../core/chat';
import { FolderUnreachable, type Fs, type ReadFs } from '../core/fs';
import { chatPlaceOf, chatRoots, paths, placeForChat, placeForJob, placeOf, resolvePath, ROOT, shownPath, type WikiPath } from '../core/layout';
import { indexEntries, namesOf, roleOf, utf8Length, type PageNameIndex } from '../core/pages';
import type { ChatTarget, DomainName } from '../core/types';
import type { Reader, Refused, Shown, Workspace } from '../agent/loop';
import type { JobTx } from './transaction';

const READ_CAP = 60_000;
const LIST_CAP = 300;
const SEARCH_CAP = 20;
const WRITE_CAP = 200 * 1024;

const shown = (text: string): Shown => ({ kind: 'shown', text });
const capped = (text: string) => (text.length > READ_CAP ? `${text.slice(0, READ_CAP)}\n[cut at ${READ_CAP} of ${text.length} characters]` : text);
const listing = (files: readonly string[], target: string) =>
  shown(files.length ? [...files.slice(0, LIST_CAP), ...(files.length > LIST_CAP ? [`[${files.length - LIST_CAP} more]`] : [])].join('\n') : `no files under ${target}`);
const wordsOf = (query: string) => query.normalize('NFC').toLowerCase().split(/\s+/).filter(Boolean);
const matching = (text: string, words: readonly string[]) => text.split('\n').filter((l) => words.some((w) => l.toLowerCase().includes(w))).slice(0, 2).map((l) => `  ${l.slice(0, 200)}`);

export function jobWorkspace(a: { readonly fs: Fs; readonly tx: JobTx; readonly declared: readonly DomainName[]; readonly reviewBefore: string | null }): Workspace {
  const { fs, tx } = a;
  const domain = tx.domain;
  /** What this job last read or wrote at each path. */
  const seen = new Map<WikiPath, string>();
  const show = (p: WikiPath) => shownPath(domain, p);
  const missing = (target: string) => shown(`error: no such file: ${target}`);

  /** A folder where a file was named answers as an error to the model; only an unreachable folder is the engine's. */
  async function textAt(path: WikiPath): Promise<string | null | Shown> {
    try {
      return await fs.readText(path);
    } catch (e) {
      if (e instanceof FolderUnreachable) throw e;
      return shown(`error: ${show(path)} is not a file`);
    }
  }

  /** The reread rule: an existing file is replaced only in the text this job last saw there. */
  function stale(path: WikiPath, now: string | null): Shown | null {
    const was = seen.get(path);
    if (now === null) return was === undefined ? null : shown(`error: ${show(path)} was deleted since you read it`);
    if (was === undefined) return shown(`error: ${show(path)} exists; read it first`);
    return was === now ? null : shown(`error: ${show(path)} changed since you read it; read it again`);
  }

  /** The file a write may change, or what the tool answers instead. */
  async function writable(target: string): Promise<{ readonly path: WikiPath; readonly review: boolean; readonly now: string | null } | Shown | Refused> {
    const place = placeForJob(domain, a.declared, target);
    if (place.kind === 'server') return shown(`error: the server writes ${show(place.path)}; only read it`);
    if (place.kind === 'readable' || place.kind === 'outside') return { kind: 'refused', path: place.path ?? target };
    const now = await textAt(place.path);
    if (typeof now === 'object' && now !== null) return now;
    return { path: place.path, review: place.kind === 'review', now };
  }

  async function put(path: WikiPath, review: boolean, text: string, done: string): Promise<Shown> {
    if (review && !text.startsWith(a.reviewBefore ?? '')) return shown(`error: ${show(path)} only takes lines added at its end`);
    if (utf8Length(text) > WRITE_CAP) return shown(`error: ${show(path)} would be over 200 KiB`);
    await tx.write(path, text);
    seen.set(path, text);
    return shown(`${done} ${show(path)}`);
  }

  return {
    async read(target) {
      const place = placeForJob(domain, a.declared, target);
      if (place.kind === 'outside') return missing(target);
      const text = await textAt(place.path);
      if (text === null) return missing(target);
      if (typeof text === 'object') return text;
      seen.set(place.path, text);
      return shown(capped(text));
    },

    async list(target) {
      const dir = resolvePath(paths.domain(domain), target);
      if (dir === null) return missing(target);
      let files: readonly WikiPath[];
      try {
        files = await fs.listTree(dir);
      } catch (e) {
        if (e instanceof FolderUnreachable) throw e;
        return shown(`error: ${target} is not a folder`);
      }
      return listing(files.filter((f) => placeOf(domain, a.declared, f).kind !== 'outside').map(show), target);
    },

    async search(query) {
      const words = wordsOf(query);
      if (!words.length) return shown('error: the query has no words');
      const hits: string[] = [];
      const prefix = `${paths.wiki(domain)}/`;
      for (const f of await fs.listTree(paths.wiki(domain))) {
        const role = roleOf(f.slice(prefix.length));
        if (role !== 'page' && role !== 'answer') continue;
        const text = ((await fs.readText(f)) ?? '').normalize('NFC');
        if (!words.every((w) => `${f}\n${text}`.toLowerCase().includes(w))) continue;
        hits.push([show(f), ...matching(text, words)].join('\n'));
        if (hits.length === SEARCH_CAP) break;
      }
      return shown(hits.length ? hits.join('\n') : `no page in wiki/ holds ${query}`);
    },

    async write(target, text) {
      const w = await writable(target);
      if ('kind' in w) return w;
      return stale(w.path, w.now) ?? put(w.path, w.review, text, w.now === null ? 'created' : 'wrote');
    },

    async edit(target, old, next) {
      const w = await writable(target);
      if ('kind' in w) return w;
      if (w.now === null) return missing(target);
      if (old === '') return shown('error: old is empty');
      const count = w.now.split(old).length - 1;
      if (count !== 1) return shown(`error: the text to replace occurs ${count} times in ${show(w.path)}; it must occur once`);
      return put(w.path, w.review, w.now.replace(old, () => next), 'edited');
    },
  };
}

/** Disk reads per question, the model's and search's together. About 1.2 s on SAF. */
export const READS_PER_ASK = 60;
/** Page bodies one search may read that this question has not read already. */
export const SEARCH_READS = 24;

/** A chat question's Reader, and the page names its answer can cite. */
export type ChatReader = Reader & {
  /** Each domain's index.md entries, plus the pages this question read: at most one read per domain, and no listing. */
  pageNames(domains: readonly DomainName[]): Promise<PageNameIndex>;
};

/**
 * One per question, so its cache and read budget are per question by construction. Paths start at
 * the wiki folder (placeForChat). SAF reads a file in ~19 ms and lists ~4.5 ms an entry on the JS
 * thread, so search never walks a tree: it ranks the entries of each searched domain's index.md by
 * the words in their path and summary, answers entries holding every word without a read, then reads
 * at most SEARCH_READS bodies best ranked first. A folder above the chat roots lists the roots.
 */
export function chatReader(a: { readonly fs: ReadFs; readonly target: ChatTarget; readonly declared: readonly DomainName[] }): ChatReader {
  const { fs, target, declared } = a;
  const cache = new Map<WikiPath, string | null>();
  let reads = 0;
  const example = `${target.kind === 'domain' ? target.domain : (declared[0] ?? '<domain>')}/wiki/index.md`;
  const missing = (named: string) => shown(`error: no such file: ${named}. Paths start at the wiki folder, as in ${example}.`);
  const spent = shown(`error: this question has read ${READS_PER_ASK} files, the most it may. Answer from what you have read.`);

  /** Cached, else one disk read from the budget. `budgeted` false: index.md, at most one per domain. */
  async function textOf(path: WikiPath, budgeted = true): Promise<string | null | Shown> {
    if (cache.has(path)) return cache.get(path)!;
    if (budgeted && reads >= READS_PER_ASK) return spent;
    if (budgeted) reads += 1;
    try {
      const text = await fs.readText(path);
      cache.set(path, text);
      return text;
    } catch (e) {
      if (e instanceof FolderUnreachable) throw e;
      return shown(`error: ${path} is not a file`);
    }
  }

  /** The pages a domain's index.md lists, as paths. */
  async function indexed(d: DomainName): Promise<readonly { readonly path: WikiPath; readonly summary: string }[]> {
    const index = await textOf(paths.index(d), false);
    if (typeof index !== 'string') return [];
    return indexEntries(index).flatMap((e) => {
      const ref = linkRef(e.target, d, declared);
      const path = ref?.domain === d ? resolvePath(ROOT, `${paths.wiki(d)}/${ref.page}.md`) : null;
      return path && chatPlaceOf(target, declared, path).kind === 'readable' ? [{ path, summary: e.summary }] : [];
    });
  }

  return {
    async read(named) {
      const place = placeForChat(target, declared, named);
      if (place.kind === 'outside') return missing(named);
      const text = await textOf(place.path);
      if (text === null) return missing(named);
      return typeof text === 'string' ? shown(capped(text)) : text;
    },

    async list(named) {
      const dir = resolvePath(ROOT, named);
      if (dir === null) return missing(named);
      const roots = chatRoots(declared);
      if (!roots.some((r) => dir === r || dir.startsWith(`${r}/`))) {
        const own = target.kind === 'domain' ? [paths.domainSchema(target.domain)] : [];
        const above = [...roots.map((r) => `${r}/`), paths.rootSchema, paths.config, ...own].filter((p) => dir === ROOT || p.startsWith(`${dir}/`));
        return above.length ? shown(above.join('\n')) : shown(`error: no such folder: ${named}`);
      }
      let files: readonly WikiPath[];
      try {
        files = await fs.listTree(dir);
      } catch (e) {
        if (e instanceof FolderUnreachable) throw e;
        return shown(`error: ${named} is not a folder`);
      }
      return listing(files.filter((f) => chatPlaceOf(target, declared, f).kind === 'readable'), named);
    },

    async search(query) {
      const words = wordsOf(query);
      if (!words.length) return shown('error: the query has no words');
      const pages = [];
      for (const d of target.kind === 'root' ? declared : [target.domain]) {
        for (const e of await indexed(d)) {
          const hay = `${e.path}\n${e.summary}`.normalize('NFC').toLowerCase();
          pages.push({ ...e, rank: words.every((w) => hay.includes(w)) ? 0 : words.some((w) => hay.includes(w)) ? 1 : 2 });
        }
      }
      pages.sort((x, y) => x.rank - y.rank);
      const hits: string[] = [];
      let bodies = 0;
      let skipped = 0;
      for (const p of pages) {
        if (hits.length === SEARCH_CAP) break;
        if (p.rank === 0) {
          hits.push(p.summary ? `${p.path}\n  ${p.summary}` : p.path);
          continue;
        }
        if (!cache.has(p.path)) {
          if (bodies >= SEARCH_READS || reads >= READS_PER_ASK) {
            skipped += 1;
            continue;
          }
          bodies += 1;
        }
        const text = await textOf(p.path);
        if (typeof text !== 'string') continue;
        const t = text.normalize('NFC');
        if (words.every((w) => `${p.path}\n${t}`.toLowerCase().includes(w))) hits.push([p.path, ...matching(t, words)].join('\n'));
      }
      const note = skipped ? [`[searched ${pages.length - skipped} of ${pages.length} pages; open others by their path in wiki/index.md]`] : [];
      return shown([...(hits.length ? hits : [`no page holds ${query}`]), ...note].join('\n'));
    },

    async pageNames(domains) {
      const out = new Map<string, ReadonlySet<string>>();
      for (const d of domains) {
        const prefix = `${paths.wiki(d)}/`;
        const listed = (await indexed(d)).map((e) => e.path.slice(prefix.length));
        const read = [...cache].filter(([p, t]) => t !== null && p.startsWith(prefix)).map(([p]) => p.slice(prefix.length));
        out.set(d, namesOf([...listed, ...read]));
      }
      return out;
    },
  };
}
