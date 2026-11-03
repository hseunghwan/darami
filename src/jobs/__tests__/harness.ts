/** The fakes the engine tests share. Not a test file: testMatch takes *.test.ts only. */

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fs } from '../../core/fs';
import type { WikiPath } from '../../core/layout';
import { presetFiles } from '../../core/presets';
import type { DomainName, Locale } from '../../core/types';
import { nodeFs } from '../../fs/node';
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

export type Cut = { readonly at: number; readonly how: 'before' | 'torn' };

/**
 * The node adapter with one kill. Changes (write, remove, create) count from 1. At `at`, 'before'
 * kills without touching the folder; 'torn' leaves the first half of the text's UTF-8 bytes, as a
 * write cut off part way does, then kills.
 */
export function faultyFs(root: string, cut: Cut | null): Fs & { changes(): number } {
  const inner = nodeFs(root);
  let changes = 0;
  const hit = async (what: string, path: WikiPath, text: string | null) => {
    changes += 1;
    if (!cut || changes !== cut.at) return;
    if (cut.how === 'torn' && text !== null) {
      const bytes = Buffer.from(text, 'utf8');
      writeFileSync(join(root, ...path.split('/')), bytes.subarray(0, Math.floor(bytes.length / 2)));
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
      await hit('create', path, (await inner.readText(path)) ? null : text);
      return inner.create(path, text);
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
