/**
 * The Workspace of agent/loop.ts over a job's transaction: the only way a model touches files.
 * Scope is core/layout placeForJob; every write goes through the journal. Reads come from the folder
 * itself, not from what the job wrote, so the reread rule sees a second writer such as Obsidian.
 */

import { FolderUnreachable, type Fs } from '../core/fs';
import { paths, placeForJob, placeOf, resolvePath, shownPath, type WikiPath } from '../core/layout';
import { roleOf, utf8Length } from '../core/pages';
import type { DomainName } from '../core/types';
import type { Refused, Shown, Workspace } from '../agent/loop';
import type { JobTx } from './transaction';

const READ_CAP = 60_000;
const LIST_CAP = 300;
const SEARCH_CAP = 20;
const WRITE_CAP = 200 * 1024;

const shown = (text: string): Shown => ({ kind: 'shown', text });

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
      return shown(text.length > READ_CAP ? `${text.slice(0, READ_CAP)}\n[cut at ${READ_CAP} of ${text.length} characters]` : text);
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
      const kept = files.filter((f) => placeOf(domain, a.declared, f).kind !== 'outside').map(show);
      if (!kept.length) return shown(`no files under ${target}`);
      return shown([...kept.slice(0, LIST_CAP), ...(kept.length > LIST_CAP ? [`[${kept.length - LIST_CAP} more]`] : [])].join('\n'));
    },

    async search(query) {
      const words = query.normalize('NFC').toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) return shown('error: the query has no words');
      const hits: string[] = [];
      const prefix = `${paths.wiki(domain)}/`;
      for (const f of await fs.listTree(paths.wiki(domain))) {
        const role = roleOf(f.slice(prefix.length));
        if (role !== 'page' && role !== 'answer') continue;
        const text = ((await fs.readText(f)) ?? '').normalize('NFC');
        if (!words.every((w) => `${f}\n${text}`.toLowerCase().includes(w))) continue;
        const lines = text.split('\n').filter((l) => words.some((w) => l.toLowerCase().includes(w))).slice(0, 2);
        hits.push([show(f), ...lines.map((l) => `  ${l.slice(0, 200)}`)].join('\n'));
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
