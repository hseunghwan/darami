/**
 * The JournalStore contract, run on the memory store every other engine test uses and on the SQL
 * the phone runs, over node:sqlite here. One list, so the two cannot drift apart.
 */

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { WikiPath } from '../../core/layout';
import type { DomainName } from '../../core/types';
import type { BookStore, MemoHeader } from '../book';
import { sqliteBook, sqliteJournal, type Sql } from '../sqlite';
import type { JournalStore } from '../transaction';
import { memoryBook, memoryJournal } from './harness';

const 스터디 = '스터디' as DomainName;
const 일상 = '일상' as DomainName;
const at = (p: string) => p as WikiPath;
const job = { kind: 'ingest' as const, id: '01JB8ZQ4M3T9X7K2W5R6N8P001', attempt: 2 };

/** node:sqlite over the Sql the store takes. Rows are copied into this realm, as assert's deepEqual tells Node's Array from jest's. */
function nodeSql(d = new DatabaseSync(':memory:')): Sql {
  return {
    execAsync: async (source) => void d.exec(source),
    getAllAsync: async <T,>(source: string, ...params: (string | number | null)[]) => [...d.prepare(source).all(...params)].map((r) => ({ ...r }) as T),
    runAsync: async (source, ...params) => d.prepare(source).run(...params),
  };
}

const stores: [string, () => JournalStore][] = [
  ['memory', () => memoryJournal()],
  ['sqlite', () => sqliteJournal('content://tree/primary%3ADocuments%2Fwiki', async () => nodeSql())],
];

describe.each(stores)('the %s store', (_, make) => {
  test('one row per domain and slot, its head as written', async () => {
    const s = make();
    await s.begin(스터디, 'job', job);
    await s.begin(스터디, 'ledger', null);
    await s.begin(일상, 'job', { ...job, kind: 'file-answer' });
    await assert.rejects(s.begin(스터디, 'job', job));
    await s.intend(스터디, 'job', '# log\n## line\n');
    await s.abandon(일상, 'job');
    const heads = [...(await s.heads())].sort((a, b) => `${a.domain}${a.slot}`.localeCompare(`${b.domain}${b.slot}`));
    assert.deepEqual(heads, [
      { domain: 스터디, slot: 'job', job, abandoning: false, intendedLog: '# log\n## line\n' },
      { domain: 스터디, slot: 'ledger', job: null, abandoning: false, intendedLog: null },
      { domain: 일상, slot: 'job', job: { ...job, kind: 'file-answer' }, abandoning: true, intendedLog: null },
    ].sort((a, b) => `${a.domain}${a.slot}`.localeCompare(`${b.domain}${b.slot}`)));
  });

  test('the first before-image of a path wins, and images come back in the order they were kept', async () => {
    const s = make();
    await s.begin(스터디, 'job', job);
    await s.before(스터디, 'job', at('스터디/wiki/z.md'), null);
    await s.before(스터디, 'job', at('스터디/wiki/a.md'), 'old\n');
    await s.before(스터디, 'job', at('스터디/wiki/z.md'), 'torn');
    await s.before(스터디, 'job', at('스터디/wiki/log.md'), '');
    assert.deepEqual(await s.befores(스터디, 'job'), [[at('스터디/wiki/z.md'), null], [at('스터디/wiki/a.md'), 'old\n'], [at('스터디/wiki/log.md'), '']]);
    assert.deepEqual(await s.befores(스터디, 'ledger'), []);
  });

  test('end removes the row and its images together, and the row can begin again empty', async () => {
    const s = make();
    await s.begin(스터디, 'job', job);
    await s.before(스터디, 'job', at('스터디/wiki/a.md'), 'old\n');
    await s.begin(일상, 'job', job);
    await s.before(일상, 'job', at('일상/wiki/b.md'), 'b\n');
    await s.end(스터디, 'job');
    assert.deepEqual((await s.heads()).map((h) => h.domain), [일상]);
    await s.begin(스터디, 'job', job);
    assert.deepEqual(await s.befores(스터디, 'job'), []);
    assert.deepEqual(await s.befores(일상, 'job'), [[at('일상/wiki/b.md'), 'b\n']]);
  });
});

test('the SQL store sees only its own folder, and keeps rows across a reopen of the same database', async () => {
  const d = new DatabaseSync(':memory:');
  const a = sqliteJournal('content://a', async () => nodeSql(d));
  const b = sqliteJournal('content://b', async () => nodeSql(d));
  await a.begin(스터디, 'job', job);
  await a.before(스터디, 'job', at('스터디/wiki/a.md'), 'x');
  assert.deepEqual(await b.heads(), []);
  await b.begin(스터디, 'job', job);
  const again = sqliteJournal('content://a', async () => nodeSql(d));
  assert.deepEqual((await again.heads()).map((h) => h.job), [job]);
  assert.deepEqual(await again.befores(스터디, 'job'), [[at('스터디/wiki/a.md'), 'x']]);
});

const header = (n: number, preview = `메모 ${n}`): MemoHeader => ({
  id: `01JB8ZQ4M3T9X7K2W5R6N8P00${n}` as MemoHeader['id'], capturedAt: '2026-10-29T08:01:00+09:00', tz: 'Asia/Seoul', source: 'typed', preview, place: n === 1 ? '중구' : null, photos: 0,
});
const commit = (pages: string[]) => ({ domain: 스터디, id: header(1).id, at: '2026-10-29T00:00:00.000Z', pages: pages.map((p) => ({ pathUnderWiki: p, change: 'created' as const, type: 'concept' })) });

const books: [string, () => BookStore][] = [
  ['memory', () => memoryBook()],
  ['sqlite', () => sqliteBook('content://tree/primary%3ADocuments%2Fwiki', async () => nodeSql())],
];

describe.each(books)('the %s book store', (_, make) => {
  test('a header stays as first stored, and a commit record is replaced by the next one for the same memo', async () => {
    const s = make();
    await s.putHeaders([header(1), header(2)]);
    await s.putHeaders([header(1, 'changed')]);
    await s.putCommit(commit(['First.md']));
    await s.putCommit(commit(['Second.md']));
    const { headers, commits } = await s.load();
    assert.deepEqual([...headers].sort((a, b) => a.id.localeCompare(b.id)), [header(1), header(2)]);
    assert.deepEqual(commits, [commit(['Second.md'])]);
  });
});

test('the SQL book store sees only its own folder, and drops a row a hand edit broke', async () => {
  const d = new DatabaseSync(':memory:');
  const a = sqliteBook('content://a', async () => nodeSql(d));
  await a.putHeaders(Array.from({ length: 120 }, (_, i) => ({ ...header(1), id: `01JB8ZQ4M3T9X7K2W5R6N8${String(i).padStart(4, '0')}` as MemoHeader['id'] })));
  await a.putCommit(commit(['RAG.md']));
  assert.deepEqual(await sqliteBook('content://b', async () => nodeSql(d)).load(), { headers: [], commits: [] });
  d.exec(`UPDATE memo_header SET source = 'fax' WHERE id = '01JB8ZQ4M3T9X7K2W5R6N80000'; UPDATE memo_commit SET pages = 'not json'`);
  const { headers, commits } = await sqliteBook('content://a', async () => nodeSql(d)).load();
  assert.equal(headers.length, 119);
  assert.deepEqual(commits, []);
});
