import * as SQLite from 'expo-sqlite';

let opened: Promise<SQLite.SQLiteDatabase> | null = null;

export function db(): Promise<SQLite.SQLiteDatabase> {
  opened ??= (async () => {
    // The name predates dotoriwiki. A phone that upgrades keeps its kv; its old outbox tables are left as they are.
    const d = await SQLite.openDatabaseAsync('llmwiki.db');
    // synchronous FULL: under WAL, NORMAL can lose the last commit to a power cut, and the job
    // journal (jobs/sqlite.ts) must never lose a before-image it was told it has.
    await d.execAsync(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    `);
    return d;
  })();
  return opened;
}

export const kv = {
  async get(key: string): Promise<string | null> {
    return (await (await db()).getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', key))?.value ?? null;
  },
  async set(key: string, value: string): Promise<void> {
    await (await db()).runAsync('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  },
  async remove(key: string): Promise<void> {
    await (await db()).runAsync('DELETE FROM kv WHERE key = ?', key);
  },
};
