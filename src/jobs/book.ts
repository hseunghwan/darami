/**
 * The memo book: the memos as the screens show them. One per engine, built only by engine.ts.
 *
 * engine.ts hands the engine its Fs and JournalStore only through here, so every list of a memo
 * folder, every memo-file and ledger read, and every create, write, and remove the engine makes
 * passes the book on its way. A transition shows the moment its write returns, and the book makes
 * no read of its own beyond the memo files it has never seen (SAF lists at ~4.5 ms an entry and
 * blocks the JS thread). An edit made outside (Obsidian, Syncthing) shows at the engine's next read
 * of that folder: a runner pass, refresh(), or memo(id).
 *
 * A memo's state is never stored: it is placementOf over the last names and ledgers the engine
 * saw. SQLite keeps only what never changes once written: a memo file's capture fields, and the
 * clock time and pages of a commit, which the ledger line cannot give back (it has a date and an
 * unmarked page list). A commit's record counts only while that job's terminal line is applied.
 *
 * A list or read that began before a write to the same folder or ledger ended is dropped, so a
 * stale snapshot never undoes the engine's own write.
 *
 * The book is also the runner's snapshot. Inside one pass, a memo folder listed whole or a ledger
 * read whole is answered from the book, which the engine's own writes keep exact, so an idle pass
 * lists each memo folder once instead of once per domain's job.
 */

import type { ConfigParse } from '../core/config';
import type { CommittedPage } from '../core/filing';
import type { Fs } from '../core/fs';
import { memoDirOf, parseWikiPath, paths, touchedBy, type WikiPath } from '../core/layout';
import { parseLedger, type Ledger } from '../core/ledger';
import { MEMO_SOURCES, pageMeta, parseMemoFile, parseMemoId, type Memo, type MemoSource, type Routing } from '../core/pages';
import { locate, memoIds, memoIdsIn, orderKey, placementOf, type Located, type Placement, type Places } from '../core/places';
import type { DomainName, MemoId } from '../core/types';
import type { JournalStore } from './transaction';

export type MemoRow = {
  readonly id: MemoId;
  readonly capturedAt: string;
  /** The first PREVIEW_CHARS characters of the text as captured. The detail reads the whole text. */
  readonly preview: string;
  readonly source: MemoSource;
  /** An ingested memo's `finished` is `{ at }` where darami recorded the commit, `{ day }` from the ledger otherwise. */
  readonly at: Placement;
};

/** `routing` as the hold file says: null when it carries none. */
export type HeldRow = MemoRow & { readonly at: Extract<Placement, { state: 'held' }>; readonly routing: Routing | null };
export type FailedRow = MemoRow & { readonly at: Extract<Placement, { state: 'failed' }> };

export type MemoBook = {
  /** False until the inbox and every declared domain's raw/, hold/, and log.md were read whole once. */
  readonly ready: boolean;
  /** Newest captured first. A memo whose file was not read yet is left out and counted in `reading`. */
  readonly rows: readonly MemoRow[];
  readonly reading: number;
  /** Oldest captured first. */
  readonly held: readonly HeldRow[];
  /** Newest captured first. */
  readonly failed: readonly FailedRow[];
  /** From placements alone, so exact before every file is read. working: inbox, routed, running. confirm: held, failed. */
  readonly counts: { readonly working: number; readonly confirm: number };
  /** A row keeps its identity across books while its placement and file are unchanged. */
  readonly byId: ReadonlyMap<MemoId, MemoRow>;
};

/** A page an ingest changed, under wiki/ without `.md`. `change` null: a commit darami did not record (dotoriwiki's, or before P4). */
export type ChangedPage = { readonly path: string; readonly type: string | null; readonly change: 'created' | 'modified' | null };

export type MemoDetail = {
  readonly id: MemoId;
  /** Read from the memo file now, so an edit made in Obsidian shows. */
  readonly text: string;
  readonly capturedAt: string;
  readonly place: string | null;
  readonly source: MemoSource;
  readonly routing: Routing | null;
  readonly at: Placement;
  /** Ingested only: the recorded pages, or the ledger's with the type each page has now. */
  readonly pages: readonly ChangedPage[];
};

export type Book = {
  /** The same object until something changes, as React's getSnapshot needs. */
  current(): MemoBook;
  /** One call per burst of changes. While nothing watches, memo files the book has not seen are not read. */
  watch(listener: () => void): () => void;
  /** null when the book has no such memo, or its file no longer reads as one. */
  memo(id: MemoId): Promise<MemoDetail | null>;
  /** Reads every memo folder, ledger, and hold file again, and clears hold copies a cut-off confirm or move left. */
  refresh(): Promise<void>;
};

export type MemoHeader = {
  readonly id: MemoId;
  readonly capturedAt: string;
  readonly tz: string;
  readonly source: MemoSource;
  readonly preview: string;
  readonly place: string | null;
  readonly photos: number;
};

export const PREVIEW_CHARS = 280;

const headerOf = (m: Memo): MemoHeader => ({
  id: m.id, capturedAt: m.capturedAt, tz: m.tz, source: m.source, preview: m.text.slice(0, PREVIEW_CHARS), place: m.location?.place ?? null, photos: m.attachments.length,
});

export type CommitRecord = { readonly domain: DomainName; readonly id: MemoId; readonly at: string; readonly pages: readonly CommittedPage[] };

/** One wiki folder's rows: SQLite on the phone (sqlite.ts), memory under jest. */
export type BookStore = {
  load(): Promise<{ readonly headers: readonly MemoHeader[]; readonly commits: readonly CommitRecord[] }>;
  /** A header never changes, so the first one stored for an id stays. */
  putHeaders(headers: readonly MemoHeader[]): Promise<void>;
  /** Replaces the record of the same domain and id. */
  putCommit(record: CommitRecord): Promise<void>;
};

/** A row read back from a store, or null when a hand edit broke it. */
export function parseHeader(v: { id: unknown; capturedAt: unknown; tz: unknown; source: unknown; preview: unknown; place: unknown; photos: unknown }): MemoHeader | null {
  const id = typeof v.id === 'string' ? parseMemoId(v.id) : null;
  const source = MEMO_SOURCES.find((s) => s === v.source);
  if (!id || !source || typeof v.capturedAt !== 'string' || typeof v.tz !== 'string' || typeof v.preview !== 'string' || typeof v.photos !== 'number') return null;
  return { id, capturedAt: v.capturedAt, tz: v.tz, source, preview: v.preview, place: typeof v.place === 'string' ? v.place : null, photos: v.photos };
}

/** One runner pass. Folders and ledgers read whole in it are not read again in it. */
export type Pass = { readonly id: number };

/** What engine.ts wires. Nothing else builds a book. */
export type BookParts = Pick<Book, 'current' | 'watch'> & {
  /** The engine's Fs from here on. */
  readonly fs: Fs;
  /** The engine's JournalStore from here on: a `job` row for an ingest is `running`. */
  readonly journal: JournalStore;
  /** Each config the engine reads: the declared domains in order. A broken config keeps the last ones seen. */
  sawConfig(c: ConfigParse): void;
  /** domain.ts, just before the applied line is written. */
  recordCommit(domain: DomainName, id: MemoId, pages: readonly CommittedPage[]): Promise<void>;
  /** accept's duplicate answer, from what the book has seen: the router drops a copy it missed. */
  located(id: MemoId): Located | 'inbox' | null;
  /** Outside any lane: engine.ts runs it in the memo lane. */
  detail(id: MemoId): Promise<MemoDetail | null>;
  pass(): Pass;
  /** The book's Fs, except that a memo folder listed whole or a ledger read whole during `pass` is answered from the book. An outside edit shows in the next pass. */
  passFs(pass: Pass): Fs;
};

export type BookDeps = {
  readonly fs: Fs;
  readonly journal: JournalStore;
  readonly store: BookStore;
  readonly now: () => Date;
  /** Spaces out the reads of memo files the book has not seen. */
  readonly defer?: (fn: () => void) => void;
};

type Folder = { readonly names: ReadonlySet<string>; readonly ids: ReadonlySet<MemoId>; readonly whole: boolean };
type Missing = { readonly id: MemoId; readonly at: Placement; readonly key: string };
/** `unread`: the memo files to read, in order. A held memo's routing is not stored, so its hold file is read once a launch. */
type Derived = { readonly book: MemoBook; readonly placements: ReadonlyMap<MemoId, Placement>; readonly unread: readonly Missing[] };

const NO_FOLDER: Folder = { names: new Set(), ids: new Set(), whole: false };
const NO_LEDGER = parseLedger('');
const JOURNAL = '\0journal';
const BATCH = 20;
const commitKey = (domain: string, id: string) => `${domain}\0${id}`;

const fileOf = (id: MemoId, at: Placement): WikiPath =>
  `${at.state === 'inbox' ? paths.inbox : at.state === 'held' ? paths.hold(at.domain) : paths.raw(at.domain)}/${id}.md` as WikiPath;

/** The memo `name` holds, or null unless `text` is a whole memo file whose id is its name. */
function memoIn(name: string, text: string | null): { readonly memo: Memo; readonly routing: Routing | null } | null {
  const parsed = text ? parseMemoFile(text) : null;
  return parsed?.ok && `${parsed.value.memo.id}.md` === name ? parsed.value : null;
}

/** Which memos the backfill reads first, so the activity fills from the top. */
function backfillOrder(a: Missing, b: Missing): number {
  const rank = (m: Missing) => (m.at.state === 'held' ? 0 : m.at.state === 'failed' ? 1 : m.at.state === 'ingested' ? 3 : 2);
  const day = (m: Missing) => (m.at.state === 'ingested' && 'day' in m.at.finished ? m.at.finished.day : '');
  return rank(a) - rank(b) || (day(a) < day(b) ? 1 : day(a) > day(b) ? -1 : 0);
}

export async function openBook({ fs: inner, journal: innerJournal, store, now, defer = (fn) => void setTimeout(fn, 0) }: BookDeps): Promise<BookParts> {
  const loaded = await store.load();
  const headers = new Map(loaded.headers.map((h) => [h.id, h] as const));
  const commits = new Map(loaded.commits.map((c) => [commitKey(c.domain, c.id), c] as const));

  let domains: readonly DomainName[] | null = null;
  const folders = new Map<string, Folder>();
  const ledgers = new Map<string, { readonly text: string; parsed: Ledger | null }>();
  let running: ReadonlyMap<DomainName, string> = new Map();
  const holdRouting = new Map<string, Routing | null>();
  /** Memos whose file did not read as the memo, by the placement it had then: not read again until that changes. */
  const unreadable = new Map<MemoId, string>();
  let ready = false;

  let seq = 0;
  const touched = new Map<string, number>();
  const mark = (key: string) => void touched.set(key, ++seq);
  const unchangedSince = (key: string, start: number) => (touched.get(key) ?? 0) <= start;
  let passes = 0;
  /** The pass in which each folder was last listed whole, or each ledger last read or written whole. */
  const readIn = new Map<string, number>();

  let derived: Derived | null = null;
  let previous = new Map<MemoId, { readonly key: string; readonly header: MemoHeader; readonly row: MemoRow }>();
  const listeners = new Set<() => void>();
  let notifying = false;
  let backfilling = false;
  const unsaved: MemoHeader[] = [];

  function changed(): void {
    derived = null;
    if (notifying) return;
    notifying = true;
    queueMicrotask(() => {
      notifying = false;
      for (const l of [...listeners]) l();
      backfill();
    });
  }

  function save(): void {
    if (unsaved.length === 0) return;
    void store.putHeaders(unsaved.splice(0)).catch(() => {});
  }

  function learn(m: Memo): void {
    if (headers.has(m.id)) return;
    headers.set(m.id, headerOf(m));
    unsaved.push(headers.get(m.id)!);
    if (!backfilling || unsaved.length >= BATCH) save();
    changed();
  }

  function setFolder(dir: string, names: ReadonlySet<string>, whole: boolean): void {
    const was = folders.get(dir);
    if (was && was.whole === whole && was.names.size === names.size && [...names].every((n) => was.names.has(n))) return;
    folders.set(dir, { names, ids: memoIdsIn([...names]), whole });
    changed();
  }

  function setName(dir: WikiPath, name: string, present: boolean): void {
    const was = folders.get(dir) ?? NO_FOLDER;
    if (was.names.has(name) === present) return;
    const names = new Set(was.names);
    if (present) names.add(name);
    else names.delete(name);
    setFolder(dir, names, was.whole);
  }

  function setLedger(path: string, text: string): void {
    if (ledgers.get(path)?.text === text) return;
    ledgers.set(path, { text, parsed: null });
    changed();
  }

  function setRouting(path: string, routing: Routing | null): void {
    if (holdRouting.has(path) && JSON.stringify(holdRouting.get(path)) === JSON.stringify(routing)) return;
    holdRouting.set(path, routing);
    changed();
  }

  function setRunning(next: ReadonlyMap<DomainName, string>): void {
    if (next.size === running.size && [...next].every(([d, id]) => running.get(d) === id)) return;
    running = next;
    changed();
  }

  /** What a memo file's text says: its header, and a hold copy's routing. */
  function sawMemoFile(dir: WikiPath, name: string, path: WikiPath, text: string | null, routingCurrent: boolean): void {
    const file = memoIn(name, text);
    if (file) learn(file.memo);
    if (routingCurrent && memoDirOf(dir)?.kind === 'hold') setRouting(path, file?.routing ?? null);
  }

  function observeRead(path: WikiPath, text: string | null, start: number): void {
    const t = touchedBy(path);
    if (t?.kind === 'ledger' && unchangedSince(path, start)) {
      setLedger(path, text ?? '');
      readIn.set(path, passes);
    }
    if (t?.kind === 'memo') sawMemoFile(t.dir, t.name, path, text, unchangedSince(t.dir, start));
  }

  async function mutate<T>(path: WikiPath, op: () => Promise<T>, after: (r: T) => void): Promise<T> {
    const t = touchedBy(path);
    if (!t) return op();
    const key = t.kind === 'memo' ? t.dir : path;
    mark(key);
    try {
      const r = await op();
      after(r);
      return r;
    } catch (e) {
      // The write may have landed part way: the next pass reads it again.
      readIn.delete(key);
      throw e;
    } finally {
      mark(key);
    }
  }

  /** The file at `path` now holds `text`. */
  function wrote(path: WikiPath, text: string): void {
    const t = touchedBy(path);
    if (t?.kind === 'ledger') {
      setLedger(path, text);
      readIn.set(path, passes);
    }
    if (t?.kind === 'memo') {
      setName(t.dir, t.name, true);
      sawMemoFile(t.dir, t.name, path, text, true);
    }
  }

  const fs: Fs = {
    async readText(path) {
      const start = seq;
      const text = await inner.readText(path);
      observeRead(path, text, start);
      return text;
    },
    async list(dir) {
      const start = seq;
      const names = await inner.list(dir);
      if (memoDirOf(dir) && unchangedSince(dir, start)) {
        setFolder(dir, new Set(names), true);
        readIn.set(dir, passes);
      }
      return names;
    },
    create: (path, text) =>
      mutate(path, () => inner.create(path, text), (r) => {
        if (r === 'created') return wrote(path, text);
        const t = touchedBy(path);
        if (t?.kind === 'memo') setName(t.dir, t.name, true);
      }),
    write: (path, text) => mutate(path, () => inner.write(path, text), () => wrote(path, text)),
    remove: (path) =>
      mutate(path, () => inner.remove(path), () => {
        const t = touchedBy(path);
        if (t?.kind === 'ledger') {
          setLedger(path, '');
          readIn.set(path, passes);
        }
        if (t?.kind === 'memo') {
          setName(t.dir, t.name, false);
          if (holdRouting.delete(path)) changed();
        }
      }),
    listTree: (dir) => inner.listTree(dir),
  };

  async function journalWrite(op: () => Promise<void>, after: () => void): Promise<void> {
    mark(JOURNAL);
    try {
      await op();
      after();
    } finally {
      mark(JOURNAL);
    }
  }

  const journal: JournalStore = {
    async heads() {
      const start = seq;
      const heads = await innerJournal.heads();
      if (unchangedSince(JOURNAL, start)) setRunning(new Map(heads.flatMap((h) => (h.slot === 'job' && h.job?.kind === 'ingest' ? [[h.domain, h.job.id] as const] : []))));
      return heads;
    },
    befores: (d, slot) => innerJournal.befores(d, slot),
    begin: (d, slot, job) =>
      journalWrite(() => innerJournal.begin(d, slot, job), () => {
        if (slot === 'job' && job?.kind === 'ingest') setRunning(new Map([...running, [d, job.id]]));
      }),
    before: (d, slot, path, text) => innerJournal.before(d, slot, path, text),
    intend: (d, slot, text) => innerJournal.intend(d, slot, text),
    abandon: (d, slot) => innerJournal.abandon(d, slot),
    end: (d, slot) =>
      journalWrite(() => innerJournal.end(d, slot), () => {
        if (slot === 'job' && running.has(d)) setRunning(new Map([...running].filter(([x]) => x !== d)));
      }),
  };

  const ledgerOf = (path: string): Ledger => {
    const l = ledgers.get(path);
    return l ? (l.parsed ??= parseLedger(l.text)) : NO_LEDGER;
  };

  function places(): Places {
    const ids = (dir: string) => (folders.get(dir) ?? NO_FOLDER).ids;
    return {
      inbox: ids(paths.inbox),
      domains: (domains ?? []).map((d) => ({ domain: d, raw: ids(paths.raw(d)), hold: ids(paths.hold(d)), ledger: ledgerOf(paths.log(d)) })),
      running,
    };
  }

  function derive(): Derived {
    if (derived) return derived;
    const p = places();
    const whole = (dir: string) => folders.get(dir)?.whole === true;
    ready ||= domains !== null && whole(paths.inbox) && domains.every((d) => whole(paths.raw(d)) && whole(paths.hold(d)) && ledgers.has(paths.log(d)));
    const placements = new Map<MemoId, Placement>();
    const unread: Missing[] = [];
    let reading = 0;
    const rows: MemoRow[] = [];
    const next = new Map<MemoId, { readonly key: string; readonly header: MemoHeader; readonly row: MemoRow }>();
    let working = 0;
    let confirm = 0;
    for (const id of memoIds(p)) {
      const found = placementOf(p, id);
      if (!found) continue;
      const record = found.state === 'ingested' ? commits.get(commitKey(found.domain, id)) : undefined;
      const at: Placement = found.state === 'ingested' && record ? { ...found, finished: { at: record.at } } : found;
      placements.set(id, at);
      if (at.state === 'held' || at.state === 'failed') confirm += 1;
      else if (at.state !== 'ingested') working += 1;
      const routing = at.state === 'held' ? (holdRouting.get(fileOf(id, at)) ?? null) : undefined;
      const key = JSON.stringify([at, routing]);
      const header = headers.get(id);
      const unseen = !header || (at.state === 'held' && !holdRouting.has(fileOf(id, at)));
      if (unseen && unreadable.get(id) !== key) unread.push({ id, at, key });
      if (!header) {
        if (unreadable.get(id) !== key) reading += 1;
        continue;
      }
      const was = previous.get(id);
      const row: MemoRow =
        was && was.key === key && was.header === header
          ? was.row
          : { id, capturedAt: header.capturedAt, preview: header.preview, source: header.source, at, ...(routing === undefined ? {} : { routing }) };
      next.set(id, { key, header, row });
      rows.push(row);
    }
    previous = next;
    rows.sort((a, b) => (orderKey(a.capturedAt, a.id) < orderKey(b.capturedAt, b.id) ? 1 : -1));
    const book: MemoBook = {
      ready,
      rows,
      reading,
      held: rows.filter((r): r is HeldRow => r.at.state === 'held').reverse(),
      failed: rows.filter((r): r is FailedRow => r.at.state === 'failed'),
      counts: { working, confirm },
      byId: new Map(rows.map((r) => [r.id, r])),
    };
    derived = { book, placements, unread: unread.sort(backfillOrder) };
    return derived;
  }

  /** Reads one memo file the book has never seen, then yields, until none is left or nothing watches. */
  function backfill(): void {
    if (backfilling || listeners.size === 0) return;
    const next = derive().unread[0];
    if (!next) return save();
    backfilling = true;
    const path = fileOf(next.id, next.at);
    defer(() => {
      void fs
        .readText(path)
        .catch(() => null)
        .then(() => {
          if (!headers.has(next.id) || (next.at.state === 'held' && !holdRouting.has(path))) {
            unreadable.set(next.id, next.key);
            changed();
          }
          backfilling = false;
          backfill();
        });
    });
  }

  async function pagesOf(at: Extract<Placement, { state: 'ingested' }>, id: MemoId): Promise<readonly ChangedPage[]> {
    const record = commits.get(commitKey(at.domain, id));
    if (record) return record.pages.map((p) => ({ path: p.pathUnderWiki.replace(/\.md$/, ''), type: p.type, change: p.change }));
    const out: ChangedPage[] = [];
    for (const p of at.pages) {
      const path = parseWikiPath(`${paths.wiki(at.domain)}/${p}`);
      const text = path ? await fs.readText(path).catch(() => null) : null;
      out.push({ path: p.replace(/\.md$/, ''), type: text === null ? null : pageMeta(p, text).type, change: null });
    }
    return out;
  }

  const readThisPass = (key: string, pass: Pass) => pass.id === passes && readIn.get(key) === pass.id;

  return {
    fs,
    journal,
    pass: () => ({ id: ++passes }),
    passFs: (pass) => ({
      ...fs,
      async list(dir) {
        const f = folders.get(dir);
        return f?.whole && memoDirOf(dir) && readThisPass(dir, pass) ? [...f.names].sort() : fs.list(dir);
      },
      async readText(path) {
        const l = ledgers.get(path);
        return l && touchedBy(path)?.kind === 'ledger' && readThisPass(path, pass) ? l.text : fs.readText(path);
      },
    }),
    current: () => derive().book,
    watch(listener) {
      listeners.add(listener);
      backfill();
      return () => void listeners.delete(listener);
    },
    sawConfig(c) {
      if (!c.ok) return;
      const declared = [...c.config.domains.keys()];
      if (domains && declared.length === domains.length && declared.every((d, i) => d === domains![i])) return;
      domains = declared;
      changed();
    },
    async recordCommit(domain, id, pages) {
      const record: CommitRecord = { domain, id, at: now().toISOString(), pages };
      await store.putCommit(record);
      commits.set(commitKey(domain, id), record);
      changed();
    },
    located(id) {
      const p = places();
      return locate(p, id) ?? (p.inbox.has(id) ? 'inbox' : null);
    },
    async detail(id) {
      const at = derive().placements.get(id);
      if (!at) return null;
      const file = memoIn(`${id}.md`, await fs.readText(fileOf(id, at)));
      if (!file) return null;
      const { memo, routing } = file;
      return { id, text: memo.text, capturedAt: memo.capturedAt, place: memo.location?.place ?? null, source: memo.source, routing, at, pages: at.state === 'ingested' ? await pagesOf(at, id) : [] };
    },
  };
}
