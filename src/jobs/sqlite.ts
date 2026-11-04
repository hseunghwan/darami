/**
 * The JournalStore, the BookStore, and the ChatStore on SQLite: lib/db.ts's expo-sqlite database
 * on the phone, node:sqlite under jest, the same SQL on both.
 *
 * SQLite holds the journal, the memo book's facts that never change once written, and the chats,
 * which live only on the phone. Nothing else of the engine: memo state and attempts are the folder
 * and its ledgers, and pauses are timing. Each method is one statement, so each is atomic without a transaction that another
 * domain's write could land inside; end() relies on ON DELETE CASCADE. Rows of a folder that is no
 * longer kept stay until it is kept again.
 */

import { parseChatId } from '../core/chat';
import type { CommittedPage } from '../core/filing';
import { parseWikiPath, type WikiPath } from '../core/layout';
import type { JobKind } from '../core/ledger';
import { parseMemoId } from '../core/pages';
import type { DomainName } from '../core/types';
import { db as appDb } from '../lib/db';
import { parseHeader, type BookStore, type CommitRecord, type MemoHeader } from './book';
import { CHAT_FAILURES, type ChatRow, type ChatStore, type TurnRecord } from './chat';
import type { JournalHead, JournalStore } from './transaction';

/** What the store needs of a database: expo-sqlite's SQLiteDatabase has it. */
export type Sql = {
  execAsync(source: string): Promise<void>;
  getAllAsync<T>(source: string, ...params: (string | number | null)[]): Promise<T[]>;
  runAsync(source: string, ...params: (string | number | null)[]): Promise<unknown>;
};

/** foreign_keys is per connection and off by default; the cascade in end() needs it. */
const JOURNAL_SCHEMA = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS journal (
    folder TEXT NOT NULL,
    domain TEXT NOT NULL,
    slot TEXT NOT NULL CHECK (slot IN ('job', 'ledger')),
    job_kind TEXT,
    job_id TEXT,
    attempt INTEGER,
    abandoning INTEGER NOT NULL DEFAULT 0,
    intended_log TEXT,
    PRIMARY KEY (folder, domain, slot)
  );
  CREATE TABLE IF NOT EXISTS journal_before (
    folder TEXT NOT NULL,
    domain TEXT NOT NULL,
    slot TEXT NOT NULL,
    path TEXT NOT NULL,
    before TEXT,
    PRIMARY KEY (folder, domain, slot, path),
    FOREIGN KEY (folder, domain, slot) REFERENCES journal (folder, domain, slot) ON DELETE CASCADE
  );
`;

type HeadRow = {
  domain: string;
  slot: string;
  job_kind: string | null;
  job_id: string | null;
  attempt: number | null;
  abandoning: number;
  intended_log: string | null;
};

const JOB_KINDS: readonly JobKind[] = ['ingest', 'file-answer', 'lint'];

/** A row read back: a value this code never wrote is dropped rather than trusted. */
function headOf(r: HeadRow): JournalHead | null {
  if (r.slot !== 'job' && r.slot !== 'ledger') return null;
  const kind = JOB_KINDS.find((k) => k === r.job_kind);
  const job = kind && r.job_id !== null && r.attempt !== null ? { kind, id: r.job_id, attempt: r.attempt } : null;
  if (r.slot === 'job' && !job) return null;
  return { domain: r.domain as DomainName, slot: r.slot, job, abandoning: r.abandoning === 1, intendedLog: r.intended_log };
}

/** The database with `schema` made, opened once and again after a failed open. */
function opener(open: () => Promise<Sql>, schema: string): () => Promise<Sql> {
  let ready: Promise<Sql> | null = null;
  return () => {
    ready ??= open().then(async (d) => {
      await d.execAsync(schema);
      return d;
    });
    ready.catch(() => (ready = null));
    return ready;
  };
}

export function sqliteJournal(folder: string, open: () => Promise<Sql> = appDb): JournalStore {
  const db = opener(open, JOURNAL_SCHEMA);
  const key = (domain: string, slot: string) => [folder, domain, slot] as const;
  return {
    async heads() {
      const rows = await (await db()).getAllAsync<HeadRow>('SELECT domain, slot, job_kind, job_id, attempt, abandoning, intended_log FROM journal WHERE folder = ?', folder);
      return rows.flatMap((r) => headOf(r) ?? []);
    },
    async befores(domain, slot) {
      const rows = await (await db()).getAllAsync<{ path: string; before: string | null }>(
        'SELECT path, before FROM journal_before WHERE folder = ? AND domain = ? AND slot = ? ORDER BY rowid',
        ...key(domain, slot),
      );
      return rows.flatMap((r) => {
        // A path edited by hand in the database must not lead the adapter out of the folder.
        const path = parseWikiPath(r.path);
        return path ? [[path, r.before] as readonly [WikiPath, string | null]] : [];
      });
    },
    async begin(domain, slot, job) {
      await (await db()).runAsync(
        'INSERT INTO journal (folder, domain, slot, job_kind, job_id, attempt) VALUES (?, ?, ?, ?, ?, ?)',
        ...key(domain, slot), job?.kind ?? null, job?.id ?? null, job?.attempt ?? null,
      );
    },
    async before(domain, slot, path, text) {
      await (await db()).runAsync('INSERT OR IGNORE INTO journal_before (folder, domain, slot, path, before) VALUES (?, ?, ?, ?, ?)', ...key(domain, slot), path, text);
    },
    async intend(domain, slot, logText) {
      await (await db()).runAsync('UPDATE journal SET intended_log = ? WHERE folder = ? AND domain = ? AND slot = ?', logText, ...key(domain, slot));
    },
    async abandon(domain, slot) {
      await (await db()).runAsync('UPDATE journal SET abandoning = 1 WHERE folder = ? AND domain = ? AND slot = ?', ...key(domain, slot));
    },
    async end(domain, slot) {
      await (await db()).runAsync('DELETE FROM journal WHERE folder = ? AND domain = ? AND slot = ?', ...key(domain, slot));
    },
  };
}

const BOOK_SCHEMA = `
  CREATE TABLE IF NOT EXISTS memo_header (
    folder TEXT NOT NULL,
    id TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    tz TEXT NOT NULL,
    source TEXT NOT NULL,
    preview TEXT NOT NULL,
    place TEXT,
    photos INTEGER NOT NULL,
    PRIMARY KEY (folder, id)
  );
  CREATE TABLE IF NOT EXISTS memo_commit (
    folder TEXT NOT NULL,
    domain TEXT NOT NULL,
    id TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    pages TEXT NOT NULL,
    PRIMARY KEY (folder, domain, id)
  );
  CREATE TABLE IF NOT EXISTS photo_write (
    folder TEXT NOT NULL,
    path TEXT NOT NULL,
    id TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (folder, path)
  );
`;

type HeaderRow = { id: string; captured_at: string; tz: string; source: string; preview: string; place: string | null; photos: number };
type CommitRow = { domain: string; id: string; finished_at: string; pages: string };
type PhotoWriteRow = { path: string; id: string; at: string };

const CHANGES = new Set(['created', 'modified']);

function pagesOf(json: string): readonly CommittedPage[] | null {
  try {
    const v: unknown = JSON.parse(json);
    if (!Array.isArray(v)) return null;
    const ok = v.every((p) => typeof p?.pathUnderWiki === 'string' && CHANGES.has(p?.change) && (p?.type === null || typeof p?.type === 'string'));
    return ok ? v.map((p) => ({ pathUnderWiki: p.pathUnderWiki, change: p.change, type: p.type })) : null;
  } catch {
    return null;
  }
}

function commitOf(r: CommitRow): CommitRecord | null {
  const id = parseMemoId(r.id);
  const pages = pagesOf(r.pages);
  return id && pages ? { domain: r.domain as DomainName, id, at: r.finished_at, pages } : null;
}

/** Rows per INSERT, far below SQLite's limit on bound values. */
const PER_INSERT = 50;

export function sqliteBook(folder: string, open: () => Promise<Sql> = appDb): BookStore {
  const db = opener(open, BOOK_SCHEMA);
  return {
    async load() {
      const d = await db();
      const headers = await d.getAllAsync<HeaderRow>('SELECT id, captured_at, tz, source, preview, place, photos FROM memo_header WHERE folder = ?', folder);
      const commits = await d.getAllAsync<CommitRow>('SELECT domain, id, finished_at, pages FROM memo_commit WHERE folder = ?', folder);
      return {
        headers: headers.flatMap((r) => parseHeader({ ...r, capturedAt: r.captured_at }) ?? []),
        commits: commits.flatMap((r) => commitOf(r) ?? []),
      };
    },
    async putHeaders(headers: readonly MemoHeader[]) {
      const d = await db();
      for (let i = 0; i < headers.length; i += PER_INSERT) {
        const batch = headers.slice(i, i + PER_INSERT);
        await d.runAsync(
          `INSERT OR IGNORE INTO memo_header (folder, id, captured_at, tz, source, preview, place, photos) VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
          ...batch.flatMap((h) => [folder, h.id, h.capturedAt, h.tz, h.source, h.preview, h.place, h.photos]),
        );
      }
    },
    async putCommit(r) {
      await (await db()).runAsync(
        'INSERT OR REPLACE INTO memo_commit (folder, domain, id, finished_at, pages) VALUES (?, ?, ?, ?, ?)',
        folder, r.domain, r.id, r.at, JSON.stringify(r.pages),
      );
    },
    async putPhotoWrite(w) {
      await (await db()).runAsync('INSERT OR IGNORE INTO photo_write (folder, path, id, at) VALUES (?, ?, ?, ?)', folder, w.path, w.id, w.at);
    },
    async photoWrites() {
      const rows = await (await db()).getAllAsync<PhotoWriteRow>('SELECT path, id, at FROM photo_write WHERE folder = ? ORDER BY rowid', folder);
      return rows.flatMap((r) => {
        const id = parseMemoId(r.id);
        const path = parseWikiPath(r.path);
        return id && path ? [{ id, path, at: r.at }] : [];
      });
    },
    async dropPhotoWrites(id) {
      await (await db()).runAsync('DELETE FROM photo_write WHERE folder = ? AND id = ?', folder, id);
    },
  };
}

/** A chat is its turns, so there is no chat row to keep in step and none a crash can leave empty. */
const CHAT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS chat_turn (
    folder TEXT NOT NULL,
    chat TEXT NOT NULL,
    n INTEGER NOT NULL CHECK (n >= 0),
    target TEXT,
    asked_at TEXT NOT NULL,
    at TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT,
    cited TEXT,
    failure TEXT,
    PRIMARY KEY (folder, chat, n),
    CHECK ((answer IS NOT NULL AND cited IS NOT NULL AND failure IS NULL) OR (answer IS NULL AND cited IS NULL AND failure IS NOT NULL))
  );
`;

type TurnRow = { chat: string; n: number; target: string | null; asked_at: string; at: string; question: string; answer: string | null; cited: string | null; failure: string | null };
type ChatListRow = { chat: string; target: string | null; created_at: string; updated_at: string; turns: number; first: string };

function citedOf(json: string): readonly string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) && v.every((c) => typeof c === 'string') ? v : [];
  } catch {
    return [];
  }
}

function turnOf(r: TurnRow): TurnRecord | null {
  const chat = parseChatId(r.chat);
  if (!chat) return null;
  const outcome: TurnRecord['outcome'] =
    r.answer !== null ? { kind: 'answered', answer: r.answer, cited: citedOf(r.cited ?? '[]') } : { kind: 'failed', failure: CHAT_FAILURES.find((f) => f === r.failure) ?? 'other' };
  return { chat, n: r.n, target: r.target, askedAt: r.asked_at, at: r.at, question: r.question, outcome };
}

/** Times are toISOString(), so text order is time order. */
export function sqliteChats(folder: string, open: () => Promise<Sql> = appDb): ChatStore {
  const db = opener(open, CHAT_SCHEMA);
  return {
    async chats() {
      const rows = await (await db()).getAllAsync<ChatListRow>(
        `SELECT chat, target, MIN(asked_at) AS created_at, MAX(at) AS updated_at, COUNT(*) AS turns,
           (SELECT question FROM chat_turn f WHERE f.folder = t.folder AND f.chat = t.chat ORDER BY n LIMIT 1) AS first
         FROM chat_turn t WHERE folder = ? GROUP BY chat ORDER BY updated_at DESC, chat DESC`,
        folder,
      );
      return rows.flatMap((r): ChatRow[] => {
        const chat = parseChatId(r.chat);
        return chat ? [{ chat, target: r.target, createdAt: r.created_at, updatedAt: r.updated_at, turns: r.turns, first: r.first }] : [];
      });
    },
    async turns(chat) {
      const rows = await (await db()).getAllAsync<TurnRow>(
        'SELECT chat, n, target, asked_at, at, question, answer, cited, failure FROM chat_turn WHERE folder = ? AND chat = ? ORDER BY n',
        folder, chat,
      );
      return rows.flatMap((r) => turnOf(r) ?? []);
    },
    async add(t) {
      const o = t.outcome;
      await (await db()).runAsync(
        'INSERT INTO chat_turn (folder, chat, n, target, asked_at, at, question, answer, cited, failure) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        folder, t.chat, t.n, t.target, t.askedAt, t.at, t.question,
        o.kind === 'answered' ? o.answer : null, o.kind === 'answered' ? JSON.stringify(o.cited) : null, o.kind === 'failed' ? o.failure : null,
      );
    },
    async forget(chat) {
      await (await db()).runAsync('DELETE FROM chat_turn WHERE folder = ? AND chat = ?', folder, chat);
    },
  };
}
