/** The fakes the engine tests share. Not a test file: testMatch takes *.test.ts only. */

import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Fs } from '../../core/fs';
import type { WikiPath } from '../../core/layout';
import { presetFiles } from '../../core/presets';
import type { DomainName, Locale } from '../../core/types';
import { nodeFs } from '../../fs/node';
import type { Model } from '../../agent/model';
import { MODEL_PROFILES } from '../../agent/model';
import type { Located } from '../../core/places';
import type { MemoId } from '../../core/types';
import type { BookStore, CommitRecord, MemoBook, MemoHeader } from '../book';
import type { ChatRow, ChatStore, TurnRecord } from '../chat';
import { openEngine, type Engine, type EngineEvent } from '../engine';
import type { JournalHead, JournalJob, JournalStore, Slot } from '../transaction';

/** Thrown at a cut: stands for the process being killed there. The engine never catches it. */
export class Killed extends Error {
  constructor(where: string) {
    super(`killed at ${where}`);
    this.name = 'Killed';
  }
}

type Row = { head: JournalHead; befores: Map<WikiPath, string | null> };

/**
 * The JournalStore in memory, each call atomic as a SQLite transaction is. One object outlives a
 * "kill", as the database does. `arm(n)` kills at the n-th call from now that changes the store, before it applies.
 */
export function memoryJournal(): JournalStore & { calls(): number; rows(): number; arm(n: number | null): void } {
  const rows = new Map<string, Row>();
  let calls = 0;
  let cutAt: number | null = null;
  const key = (d: DomainName, s: Slot) => `${d}\0${s}`;
  const change = (what: string) => {
    calls += 1;
    if (calls === cutAt) {
      cutAt = null;
      throw new Killed(`store.${what} (${calls})`);
    }
  };
  const row = (d: DomainName, s: Slot) => {
    const r = rows.get(key(d, s));
    if (!r) throw new Error(`no journal row ${d} ${s}`);
    return r;
  };
  return {
    calls: () => calls,
    rows: () => rows.size,
    arm: (n) => {
      cutAt = n === null ? null : calls + n;
    },
    async heads() {
      return [...rows.values()].map((r) => ({ ...r.head }));
    },
    async befores(d, s) {
      return [...(rows.get(key(d, s))?.befores ?? [])];
    },
    async begin(d, s, job: JournalJob | null) {
      change('begin');
      if (rows.has(key(d, s))) throw new Error(`journal row ${d} ${s} exists`);
      rows.set(key(d, s), { head: { domain: d, slot: s, job, abandoning: false, intendedLog: null }, befores: new Map() });
    },
    async before(d, s, path, text) {
      change('before');
      const r = row(d, s);
      if (!r.befores.has(path)) r.befores.set(path, text);
    },
    async intend(d, s, logText) {
      change('intend');
      const r = row(d, s);
      r.head = { ...r.head, intendedLog: logText };
    },
    async abandon(d, s) {
      change('abandon');
      const r = row(d, s);
      r.head = { ...r.head, abandoning: true };
    },
    async end(d, s) {
      change('end');
      rows.delete(key(d, s));
    },
  };
}

/** The node adapter, counting each call by method and path. `reset()` starts the count again. */
export function countingFs(inner: Fs): Fs & { calls(method: keyof Fs, match?: (path: string) => boolean): number; listed(): string[]; reset(): void } {
  let log: [keyof Fs, string][] = [];
  const counted = <K extends keyof Fs>(method: K) => ((path: WikiPath, ...rest: unknown[]) => {
    log.push([method, path]);
    return (inner[method] as (...a: unknown[]) => unknown)(path, ...rest);
  }) as Fs[K];
  return {
    readText: counted('readText'),
    list: counted('list'),
    create: counted('create'),
    write: counted('write'),
    remove: counted('remove'),
    listTree: counted('listTree'),
    readBytes: counted('readBytes'),
    createBytes: counted('createBytes'),
    calls: (method, match = () => true) => log.filter(([m, p]) => m === method && match(p)).length,
    listed: () => log.filter(([m]) => m === 'list').map(([, p]) => p).sort(),
    reset: () => void (log = []),
  };
}

export type Cut = { readonly at: number; readonly how: 'before' | 'torn' };

/**
 * The node adapter with one kill. Changes (write, remove, and a create that writes) count from 1.
 * At `at`, 'before' kills without touching the folder; 'torn' leaves the first half of the
 * bytes, as a write cut off part way does, then kills.
 */
export function faultyFs(root: string, cut: Cut | null): Fs & { changes(): number } {
  const inner = nodeFs(root);
  let changes = 0;
  const hit = async (what: string, path: WikiPath, content: string | Uint8Array | null) => {
    changes += 1;
    if (!cut || changes !== cut.at) return;
    if (cut.how === 'torn' && content !== null) {
      const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
      const at = join(root, ...path.split('/'));
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, bytes.subarray(0, Math.floor(bytes.length / 2)));
    }
    throw new Killed(`${what} ${path} (${changes}, ${cut.how})`);
  };
  return {
    ...inner,
    changes: () => changes,
    async write(path, text) {
      await hit('write', path, text);
      return inner.write(path, text);
    },
    async create(path, text) {
      if (!(await inner.readText(path).catch(() => 'not a file'))) await hit('create', path, text);
      return inner.create(path, text);
    },
    async createBytes(path, bytes) {
      if (!(await inner.readBytes(path).catch(() => null))?.length) await hit('createBytes', path, bytes);
      return inner.createBytes(path, bytes);
    },
    async remove(path) {
      await hit('remove', path, null);
      return inner.remove(path);
    },
  };
}

/** Every file under root, dot names included, with its bytes as text. */
export function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (e.isFile()) out.set(join(e.parentPath, e.name).slice(root.length + 1).normalize('NFC'), readFileSync(join(e.parentPath, e.name), 'latin1'));
  }
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** The paths whose bytes differ between two snapshots, added and removed ones included. */
export function changed(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): string[] {
  return [...new Set([...a.keys(), ...b.keys()])].filter((p) => a.get(p) !== b.get(p)).sort();
}

export const read = (root: string, path: string): string => readFileSync(join(root, ...path.split('/')), 'utf8');

/** A fresh folder holding `locale`'s preset, time_zone Asia/Seoul, written through the node adapter. */
export async function presetWiki(locale: Locale = 'ko'): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'darami-engine-'));
  const fs = nodeFs(root);
  for (const f of presetFiles(locale, 'Asia/Seoul')) await fs.create(f.path, f.text);
  return root;
}

/** 2026-10-29 09:00 in Seoul: the day made-by-dotoriwiki's lines carry. */
export const FIXTURE_NOW = (): Date => new Date('2026-10-29T00:00:00Z');

export type Store = ReturnType<typeof memoryJournal>;
export type Kill = { readonly fs: Cut } | { readonly store: number };
const where = (k: Kill) => ('fs' in k ? `fs change ${k.fs.at} ${k.fs.how}` : `store change ${k.store}`);
const killsOf = (fsChanges: number, storeChanges: number): Kill[] => [
  ...Array.from({ length: fsChanges }, (_, i) => (['before', 'torn'] as const).map((how): Kill => ({ fs: { at: i + 1, how } }))).flat(),
  ...Array.from({ length: storeChanges }, (_, i): Kill => ({ store: i + 1 })),
];

/**
 * Kills `act` at every point: each fs change cut before it and torn, and each store change. After
 * each kill, `reopen` runs on the same folder and store, once whole and once killed at each of its
 * own points and then run again whole. `check` sees every end state. Answers how many it saw.
 */
export async function everyKill(a: {
  readonly fresh: () => Promise<{ readonly root: string; readonly store: Store }>;
  readonly act: (fs: Fs, store: Store) => Promise<void>;
  readonly reopen: (fs: Fs, store: Store) => Promise<void>;
  readonly check: (root: string, store: Store, where: string) => void | Promise<void>;
}): Promise<number> {
  const counted = async (run: (fs: Fs, store: Store) => Promise<void>, w: { root: string; store: Store }) => {
    const fs = faultyFs(w.root, null);
    const before = w.store.calls();
    await run(fs, w.store);
    return { fs: fs.changes(), store: w.store.calls() - before };
  };
  const killed = async (run: (fs: Fs, store: Store) => Promise<void>, w: { root: string; store: Store }, k: Kill) => {
    const fs = faultyFs(w.root, 'fs' in k ? k.fs : null);
    w.store.arm('store' in k ? k.store : null);
    const ok = await run(fs, w.store).then(() => true, (e: unknown) => {
      if (!(e instanceof Killed)) throw e;
      return false;
    });
    w.store.arm(null);
    if (ok) throw new Error(`not killed at ${where(k)}`);
  };
  const clean = await counted(a.act, await a.fresh());
  let seen = 0;
  for (const first of killsOf(clean.fs, clean.store)) {
    const probe = await a.fresh();
    await killed(a.act, probe, first);
    const again = await counted(a.reopen, probe);
    await a.check(probe.root, probe.store, where(first));
    seen += 1;
    for (const second of killsOf(again.fs, again.store)) {
      const w = await a.fresh();
      await killed(a.act, w, first);
      await killed(a.reopen, w, second);
      await a.reopen(faultyFs(w.root, null), w.store);
      await a.check(w.root, w.store, `${where(first)}, then in reopen ${where(second)}`);
      seen += 1;
    }
  }
  return seen;
}

/** The BookStore in memory. One object outlives a reopen, as the database does. */
export function memoryBook(): BookStore {
  const headers = new Map<string, MemoHeader>();
  const commits = new Map<string, CommitRecord>();
  return {
    async load() {
      return { headers: [...headers.values()], commits: [...commits.values()] };
    },
    async putHeaders(hs) {
      for (const h of hs) if (!headers.has(h.id)) headers.set(h.id, h);
    },
    async putCommit(r) {
      commits.set(`${r.domain}\0${r.id}`, r);
    },
  };
}

/** The ChatStore in memory, with sqliteChats' order. One object outlives a reopen, as the database does. */
export function memoryChats(): ChatStore {
  const turns = new Map<string, TurnRecord[]>();
  return {
    async chats() {
      const rows: ChatRow[] = [...turns.values()].map((ts) => ({
        chat: ts[0]!.chat,
        target: ts[0]!.target,
        createdAt: ts.map((t) => t.askedAt).sort()[0]!,
        updatedAt: ts.map((t) => t.at).sort().at(-1)!,
        turns: ts.length,
        first: ts[0]!.question,
      }));
      return rows.sort((a, b) => (a.updatedAt !== b.updatedAt ? (a.updatedAt < b.updatedAt ? 1 : -1) : a.chat < b.chat ? 1 : -1));
    },
    async turns(chat) {
      return [...(turns.get(chat) ?? [])];
    },
    async add(t) {
      const ts = turns.get(t.chat) ?? [];
      if (ts.some((x) => x.n === t.n)) throw new Error(`chat turn ${t.chat} ${t.n} exists`);
      turns.set(t.chat, [...ts, t].sort((a, b) => a.n - b.n));
    },
    async forget(chat) {
      turns.delete(chat);
    },
  };
}

/** The engine on a folder and a store, as the phone opens it, on the fixture's clock. */
export const engineOn = (fs: Fs, store: JournalStore, model: Model, events: EngineEvent[] = [], book: BookStore = memoryBook(), chats: ChatStore = memoryChats()): Promise<Engine> =>
  openEngine({ fs, journal: store, book, chats, model, machine: { modelProfiles: MODEL_PROFILES }, now: FIXTURE_NOW, onEvent: (e) => events.push(e) });

/** The next book a watcher hears that `ok` accepts, or this one. Reading memo files the book has not seen needs a watcher. */
export function bookWhere(e: Engine, ok: (b: MemoBook) => boolean): Promise<MemoBook> {
  return new Promise((resolve) => {
    if (ok(e.book.current())) return resolve(e.book.current());
    const off = e.book.watch(() => {
      if (!ok(e.book.current())) return;
      off();
      resolve(e.book.current());
    });
  });
}

/** Where the book puts a memo after reading the folder again, in locate()'s words. */
export async function placed(e: Engine, id: string): Promise<Located | 'inbox' | null> {
  await e.book.refresh();
  const at = (await bookWhere(e, (b) => b.reading === 0)).byId.get(id as MemoId)?.at;
  return !at ? null : at.state === 'inbox' ? 'inbox' : { domain: at.domain, state: at.state };
}

export const NO_SIGNAL = new AbortController().signal;
export const run = (e: Engine, d: string, withModel = true) => e.runNext(d as DomainName, { withModel, signal: NO_SIGNAL });

/** A folder set up once and copied for each run, with an empty journal: `make` must leave no journal row. */
export async function template(make: () => Promise<{ readonly root: string; readonly store: Store }>): Promise<() => Promise<{ readonly root: string; readonly store: Store }>> {
  const made = await make();
  if (made.store.rows() !== 0) throw new Error('the template left a journal row');
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'darami-engine-'));
    cpSync(made.root, root, { recursive: true });
    return { root, store: memoryJournal() };
  };
}
