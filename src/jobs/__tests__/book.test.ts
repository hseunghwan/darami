/**
 * The memo book on the real engine: a preset wiki through the node adapter, the memory journal and
 * book store, and the fake model. A counting Fs turns "the book adds no read of its own" into a
 * number the test checks.
 */

import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdtempSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fs } from '../../core/fs';
import type { WikiPath } from '../../core/layout';
import type { DomainName, MemoId } from '../../core/types';
import { nodeFs } from '../../fs/node';
import { memo, page, ulid, validFields } from '../../core/__tests__/helpers';
import { fakeModel, turn, type Script } from '../../agent/__tests__/fake-model';
import type { Engine } from '../engine';
import { bookWhere, countingFs, engineOn, FIXTURE_NOW, Killed, memoryBook, memoryJournal, presetWiki, read, run, NO_SIGNAL, snapshot } from './harness';

const 스터디 = '스터디' as DomainName;
const 일상 = '일상' as DomainName;
const id = (n: number) => ulid(n) as MemoId;
const FIXTURE = join(__dirname, '..', '..', 'core', '__tests__', 'fixtures', 'made-by-dotoriwiki');
const row = (e: Engine, n: number) => e.book.current().byId.get(id(n));
const broken = (n: number) => turn.write('wiki/a.md', page(validFields(ulid(n)), '[[없음]]\n'));

async function wiki(script: Script = {}, wrap: (fs: Fs) => Fs = (fs) => fs) {
  const root = await presetWiki('ko');
  const fs = countingFs(nodeFs(root));
  const engine = await engineOn(wrap(fs), memoryJournal(), fakeModel(script));
  await engine.book.refresh();
  fs.reset();
  return { root, fs, engine };
}

test('an accepted memo is in the book before any pass, and costs the book no folder read', async () => {
  const w = await wiki();
  assert.equal(w.engine.book.current().ready, true);
  await w.engine.accept(memo(1, '오늘 배운 것'));
  assert.deepEqual(w.engine.book.current().rows, [{ id: id(1), capturedAt: '2026-10-29T08:01:00+09:00', preview: '오늘 배운 것', source: 'typed', photos: 0, at: { state: 'inbox' } }]);
  assert.deepEqual(w.engine.book.current().counts, { working: 1, confirm: 0 });
  assert.equal(w.fs.calls('list'), 0);
  assert.equal(w.fs.calls('readText'), 0);
});

test('a routed memo is filed with its clock time, and its detail names each page with its change and type', async () => {
  const w = await wiki({ ingest: (_r, n) => (n === 1 ? turn.write('wiki/RAG.md', page(validFields(ulid(1), { type: 'concept' }), '본문.\n')) : turn.finish('created')) });
  await w.engine.accept(memo(1, 'RAG 청크', { domain_hint: '스터디' }));
  await w.engine.routeNext(NO_SIGNAL);
  assert.deepEqual(row(w.engine, 1)?.at, { state: 'routed', domain: 스터디, retry: null });
  await run(w.engine, '스터디');
  assert.deepEqual(row(w.engine, 1)?.at, { state: 'ingested', domain: 스터디, verdict: 'created', pages: ['RAG.md'], finished: { at: FIXTURE_NOW().toISOString() } });
  const detail = await w.engine.book.memo(id(1));
  assert.equal(detail?.text, 'RAG 청크');
  assert.deepEqual(detail?.routing, { by: 'hint' });
  assert.deepEqual(detail?.pages, [{ path: 'RAG', type: 'concept', change: 'created' }]);
});

test('hold, confirm, move, give-up, and retry each show the moment the engine makes them', async () => {
  let attempts = 0;
  const w = await wiki({
    classify: () => turn.route('스터디', 0.4, '애매함'),
    ingest: (_r, n) => (n === 1 && ++attempts <= 3 ? broken(2) : turn.finish('unchanged')),
  });
  await w.engine.accept(memo(1, '애매한 메모'));
  await w.engine.accept(memo(2, '또 애매한 메모'));
  await w.engine.routeNext(NO_SIGNAL);
  await w.engine.routeNext(NO_SIGNAL);
  assert.deepEqual(w.engine.book.current().held.map((h) => [h.id, h.at, h.routing]), [
    [id(1), { state: 'held', domain: 스터디 }, { by: 'classifier', confidence: 0.4, reason: '애매함' }],
    [id(2), { state: 'held', domain: 스터디 }, { by: 'classifier', confidence: 0.4, reason: '애매함' }],
  ]);
  assert.deepEqual(w.engine.book.current().counts, { working: 0, confirm: 2 });
  await w.engine.move(id(1), 일상);
  assert.deepEqual(row(w.engine, 1)?.at, { state: 'routed', domain: 일상, retry: null });
  await w.engine.confirm(id(2));
  assert.deepEqual(row(w.engine, 2)?.at, { state: 'routed', domain: 스터디, retry: null });
  await run(w.engine, '스터디');
  assert.deepEqual(row(w.engine, 2)?.at, { state: 'routed', domain: 스터디, retry: { attempts: 1, max: 3, code: 'broken-link', detail: '스터디/wiki/a.md: [[없음]] does not resolve' } });
  await run(w.engine, '스터디');
  await run(w.engine, '스터디');
  assert.deepEqual(w.engine.book.current().failed.map((f) => f.at), [
    { state: 'failed', domain: 스터디, failure: { attempts: 3, max: 3, code: 'broken-link', detail: '스터디/wiki/a.md: [[없음]] does not resolve' }, finished: { day: '2026-10-29' } },
  ]);
  assert.equal(await w.engine.retry(스터디, id(2)), 'retrying');
  assert.deepEqual(row(w.engine, 2)?.at, { state: 'routed', domain: 스터디, retry: null });
});

test('an edit made outside shows after refresh, not before', async () => {
  const w = await wiki({ classify: () => turn.route('스터디', 0.4, '애매함') });
  await w.engine.accept(memo(1, '애매한 메모'));
  await w.engine.routeNext(NO_SIGNAL);
  unlinkSync(join(w.root, '스터디', 'hold', `${ulid(1)}.md`));
  assert.equal(w.engine.book.current().held.length, 1);
  await w.engine.book.refresh();
  assert.deepEqual(w.engine.book.current().held, []);
  assert.equal(row(w.engine, 1), undefined);
});

test('a list that began before an engine write never undoes it', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let rawLists: number | null = null;
  let reached!: () => void;
  const listing = new Promise<void>((r) => (reached = r));
  const held = (fs: Fs): Fs => ({
    ...fs,
    async list(dir) {
      const names = await fs.list(dir);
      if (dir === '스터디/raw' && rawLists !== null && ++rawLists === 2) {
        reached();
        await gate;
      }
      return names;
    },
  });
  const w = await wiki({ classify: () => turn.route('스터디', 0.4, '애매함') }, held);
  await w.engine.accept(memo(1, '애매한 메모'));
  await w.engine.routeNext(NO_SIGNAL);
  rawLists = 0;
  const job = run(w.engine, '스터디');
  await listing;
  assert.deepEqual(await w.engine.confirm(id(1)), { kind: 'released', domain: 스터디 });
  release();
  await job;
  assert.deepEqual(row(w.engine, 1)?.at, { state: 'routed', domain: 스터디, retry: null });
});

test('a second engine on the same store reads no memo file the first one saw', async () => {
  const root = await presetWiki('ko');
  const store = memoryJournal();
  const book = memoryBook();
  const a = await engineOn(nodeFs(root), store, fakeModel({}), [], book);
  for (const n of [1, 2, 3]) await a.accept(memo(n, `메모 ${n}`, { domain_hint: '스터디' }));
  for (const _ of [1, 2, 3]) await a.routeNext(NO_SIGNAL);
  const fs = countingFs(nodeFs(root));
  const b = await engineOn(fs, store, fakeModel({}), [], book);
  await b.book.refresh();
  const seen = await bookWhere(b, (x) => x.reading === 0);
  assert.deepEqual(seen.rows.map((r) => r.id).sort(), [id(1), id(2), id(3)]);
  assert.equal(fs.calls('readText', (p) => p.startsWith('스터디/raw/')), 0);
});

test('after a relaunch, a held memo whose file the store already knows shows its guess once the book reads the hold copy again', async () => {
  const root = await presetWiki('ko');
  const store = memoryJournal();
  const book = memoryBook();
  const model = fakeModel({ classify: () => turn.route('스터디', 0.4, '애매함') });
  const a = await engineOn(nodeFs(root), store, model, [], book);
  await a.accept(memo(1, '애매한 메모'));
  await a.routeNext(NO_SIGNAL);
  const b = await engineOn(nodeFs(root), store, model, [], book);
  await run(b, '스터디');
  assert.equal(b.book.current().held[0]?.routing, null, 'a pass lists hold/ but reads no hold copy');
  const seen = await bookWhere(b, (x) => x.held[0]?.routing != null);
  assert.deepEqual(seen.held[0]?.routing, { by: 'classifier', confidence: 0.4, reason: '애매함' });
  assert.equal(seen.reading, 0);
});

test('a wiki dotoriwiki made opens whole, with the ledger\'s days and pages that carry no change, and no byte changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'darami-book-'));
  cpSync(FIXTURE, root, { recursive: true });
  const before = snapshot(root);
  const e = await engineOn(nodeFs(root), memoryJournal(), fakeModel({}));
  await e.book.refresh();
  const b = await bookWhere(e, (x) => x.ready && x.reading === 0);
  assert.deepEqual(b.rows.map((r) => [r.id, r.at.state]), [
    [id(7), 'held'], [id(6), 'ingested'], [id(5), 'ingested'], [id(4), 'ingested'], [id(3), 'ingested'], [id(2), 'ingested'], [id(1), 'inbox'],
  ]);
  assert.deepEqual(row(e, 2)?.at, { state: 'ingested', domain: 스터디, verdict: 'created', pages: ['RAG.md'], finished: { day: '2026-10-29' } });
  assert.deepEqual(b.held.map((h) => h.routing), [{ by: 'classifier', confidence: 0.3, reason: '애매함' }]);
  assert.deepEqual((await e.book.memo(id(2)))?.pages, [{ path: 'RAG', type: 'concept', change: null }]);
  assert.deepEqual((await e.book.memo(id(6)))?.routing, { by: 'user', from: 스터디, previous: { by: 'hint' } });
  assert.deepEqual(b.counts, { working: 1, confirm: 1 });
  assert.deepEqual(snapshot(root), before);
});

test('a commit record whose line never landed counts for nothing, and the next attempt\'s replaces it', async () => {
  const root = await presetWiki('ko');
  const store = memoryJournal();
  const book = memoryBook();
  let attempt = 0;
  const model = fakeModel({
    ingest: (_r, n) => (n > 1 ? turn.finish('created') : ++attempt === 1 ? turn.write('wiki/First.md', page(validFields(ulid(1)))) : turn.write('wiki/Second.md', page(validFields(ulid(1))))),
  });
  const killAtLog = (fs: Fs): Fs => ({
    ...fs,
    async write(path: WikiPath, text: string) {
      if (path === '스터디/wiki/log.md' && text.includes('새 페이지')) throw new Killed(path);
      return fs.write(path, text);
    },
  });
  const a = await engineOn(killAtLog(nodeFs(root)), store, model, [], book);
  await a.accept(memo(1, '메모', { domain_hint: '스터디' }));
  await a.routeNext(NO_SIGNAL);
  await assert.rejects(run(a, '스터디'), Killed);
  const b = await engineOn(nodeFs(root), store, model, [], book);
  await b.book.refresh();
  await bookWhere(b, (x) => x.reading === 0);
  assert.deepEqual(row(b, 1)?.at, { state: 'routed', domain: 스터디, retry: { attempts: 1, max: 3, code: 'interrupted', detail: 'app stopped mid-job' } });
  assert.equal((await run(b, '스터디')).kind, 'committed');
  assert.deepEqual((await b.book.memo(id(1)))?.pages, [{ path: 'Second', type: 'concept', change: 'created' }]);
  assert.match(read(root, '스터디/wiki/log.md'), /새 페이지 \| Second\.md\n$/);
});

test('a pass that changes nothing tells no watcher, and a change keeps every row it did not touch', async () => {
  const w = await wiki();
  await w.engine.accept(memo(1, '하나', { domain_hint: '스터디' }));
  await w.engine.accept(memo(2, '둘', { domain_hint: '일상' }));
  await w.engine.routeNext(NO_SIGNAL);
  const first = row(w.engine, 1);
  const second = row(w.engine, 2);
  let heard = 0;
  const off = w.engine.book.watch(() => void (heard += 1));
  for (const d of ['스터디', '일상', '미루기 아카이빙']) await run(w.engine, d, false);
  await Promise.resolve();
  assert.equal(heard, 0);
  await w.engine.routeNext(NO_SIGNAL);
  off();
  assert.equal(row(w.engine, 1), first);
  assert.notEqual(row(w.engine, 2), second);
  assert.deepEqual(row(w.engine, 2)?.at, { state: 'routed', domain: 일상, retry: null });
});

test('a header is learned once per install: a hand-broken memo file is read once and skipped', async () => {
  const w = await wiki();
  await w.engine.accept(memo(1, '메모', { domain_hint: '스터디' }));
  await w.engine.routeNext(NO_SIGNAL);
  appendFileSync(join(w.root, 'inbox', `${ulid(9)}.md`), 'not a memo\n');
  await w.engine.book.refresh();
  w.fs.reset();
  const b = await bookWhere(w.engine, (x) => x.reading === 0);
  assert.deepEqual(b.rows.map((r) => r.id), [id(1)]);
  assert.equal(w.fs.calls('readText', (p) => p === `inbox/${ulid(9)}.md`), 1);
});
