/**
 * The JournalStore on SQLite: lib/db.ts's expo-sqlite database on the phone, node:sqlite under jest,
 * the same SQL on both.
 *
 * SQLite holds the journal and nothing else of the engine: memo state and attempts are the folder
 * and its ledgers, and pauses are timing. Each method is one statement, so each is atomic without a
 * transaction that another domain's write could land inside; end() relies on ON DELETE CASCADE.
 * Rows of a folder that is no longer kept stay until it is kept again.
 */

import { parseWikiPath, type WikiPath } from '../core/layout';
import type { JobKind } from '../core/ledger';
import type { DomainName } from '../core/types';
import { db as appDb } from '../lib/db';
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

export function sqliteJournal(folder: string, open: () => Promise<Sql> = appDb): JournalStore {
  let ready: Promise<Sql> | null = null;
  const db = () => {
    ready ??= open().then(async (d) => {
      await d.execAsync(JOURNAL_SCHEMA);
      return d;
    });
    ready.catch(() => (ready = null));
    return ready;
  };
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
