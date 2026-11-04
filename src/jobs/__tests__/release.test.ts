import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMemoFile, renderMemoFile } from '../../core/pages';
import type { DomainName, MemoId } from '../../core/types';
import { nodeFs } from '../../fs/node';
import { memo, page, ulid, validFields } from '../../core/__tests__/helpers';
import { fakeModel, turn, type Reply, type Script } from '../../agent/__tests__/fake-model';
import { changed, engineOn, everyKill, memoryJournal, placed, presetWiki, read, run, NO_SIGNAL, snapshot, template } from './harness';

const 스터디 = '스터디' as DomainName;
const 일상 = '일상' as DomainName;
const ID = ulid(1) as MemoId;
const exists = (root: string, p: string) => snapshot(root).has(p);

async function wiki(script: Script) {
  const root = await presetWiki('ko');
  const store = memoryJournal();
  const engine = await engineOn(nodeFs(root), store, fakeModel(script));
  return { root, store, engine };
}

/** Memo 1 held in 스터디 by a classifier unsure of it. */
async function heldMemo(script: Script = {}) {
  const w = await wiki({ classify: () => turn.route('스터디', 0.4, '애매함'), ...script });
  await w.engine.accept(memo(1, '애매한 메모'));
  assert.equal((await w.engine.routeNext(NO_SIGNAL)).kind, 'held');
  return w;
}

const broken = (id: string) => page(validFields(id), '[[없음]]\n');

/** Memo 1 given up in 스터디 after three broken links, with a sidecar; later attempts in other domains file it. */
async function gaveUpMemo() {
  let inStudy = 0;
  const w = await wiki({
    ingest: (_r, n) => (n === 2 ? turn.finish('created') : ++inStudy <= 3 ? turn.write('wiki/a.md', broken(ID)) : turn.finish('unchanged')),
  });
  await w.engine.accept(memo(1, '메모', { domain_hint: '스터디' }));
  await w.engine.routeNext(NO_SIGNAL);
  writeFileSync(join(w.root, '스터디', 'raw', `${ID}.source.md`), '---\nmemo: x\n---\n본문\n');
  for (const want of ['retrying', 'retrying', 'gave-up']) assert.equal((await run(w.engine, '스터디')).kind, want);
  return w;
}

test('the book lists held memos with their routing, and confirm moves one into raw/ byte for byte', async () => {
  const w = await heldMemo();
  await w.engine.book.refresh();
  assert.deepEqual(w.engine.book.current().held, [{ id: ID, capturedAt: '2026-10-29T08:01:00+09:00', preview: '애매한 메모', source: 'typed', photos: 0, at: { state: 'held', domain: 스터디 }, routing: { by: 'classifier', confidence: 0.4, reason: '애매함' } }]);
  const holdText = read(w.root, `스터디/hold/${ID}.md`);
  assert.deepEqual(await w.engine.confirm(ID), { kind: 'released', domain: 스터디 });
  assert.equal(read(w.root, `스터디/raw/${ID}.md`), holdText);
  assert.equal(exists(w.root, `스터디/hold/${ID}.md`), false);
  assert.deepEqual(w.engine.book.current().held, []);
  assert.deepEqual(await w.engine.confirm(ID), { kind: 'conflict', at: { domain: 스터디, state: 'routed' } });
  assert.deepEqual(await w.engine.confirm(ulid(9) as MemoId), { kind: 'not-found' });
});

test('refresh finishes a confirm cut off: a whole raw copy wins over the hold copy, and a torn one goes', async () => {
  const w = await heldMemo();
  const holdText = read(w.root, `스터디/hold/${ID}.md`);
  writeFileSync(join(w.root, '스터디', 'raw', `${ID}.md`), holdText.slice(0, 30));
  await w.engine.book.refresh();
  assert.equal(exists(w.root, `스터디/raw/${ID}.md`), false, 'a raw copy cut off is not the memo, and it goes, so confirm can run again');
  assert.equal(w.engine.book.current().held.length, 1);
  assert.deepEqual(await w.engine.confirm(ID), { kind: 'released', domain: 스터디 });
  writeFileSync(join(w.root, '스터디', 'hold', `${ID}.md`), holdText);
  await w.engine.book.refresh();
  assert.deepEqual(w.engine.book.current().held, [], 'a whole raw copy is the memo');
  assert.equal(exists(w.root, `스터디/hold/${ID}.md`), false);
});

test('a held memo moves into another domain\'s raw/ with routing by user, and no retry line where it never was', async () => {
  const w = await heldMemo();
  const before = snapshot(w.root);
  assert.deepEqual(await w.engine.move(ID, 일상), { kind: 'released', domain: 일상 });
  const moved = parseMemoFile(read(w.root, `일상/raw/${ID}.md`));
  assert.ok(moved.ok);
  assert.deepEqual(moved.value.routing, { by: 'user', from: '스터디', previous: { by: 'classifier', confidence: 0.4, reason: '애매함' } });
  assert.deepEqual(changed(before, snapshot(w.root)), [`스터디/hold/${ID}.md`, `일상/raw/${ID}.md`]);
  assert.deepEqual(await w.engine.move(ID, 스터디), { kind: 'conflict', at: { domain: 일상, state: 'routed' } });
});

test('a gave-up memo moves with its sidecar, leaves a moved line behind, and is filed in its new domain; it never moves once ingested', async () => {
  const w = await gaveUpMemo();
  assert.deepEqual(await w.engine.move(ID, 일상), { kind: 'released', domain: 일상 });
  assert.equal(exists(w.root, `스터디/raw/${ID}.md`), false);
  assert.equal(exists(w.root, `스터디/raw/${ID}.source.md`), false);
  assert.equal(read(w.root, `일상/raw/${ID}.source.md`), '---\nmemo: x\n---\n본문\n');
  assert.ok(read(w.root, '스터디/wiki/log.md').endsWith(`## [2026-10-29] ingest | ${ID} | 이동 → 일상 | -\n`));
  assert.deepEqual(await run(w.engine, '일상'), { kind: 'committed', job: { kind: 'ingest', domain: 일상, id: ID }, verdict: 'unchanged' });
  assert.deepEqual(await w.engine.move(ID, 스터디), { kind: 'conflict', at: { domain: 일상, state: 'ingested' } });
  assert.equal(await w.engine.retry(스터디, ID), 'not-failed', 'moved on');
});

test('moving a memo back into a domain that closed it writes a retry line there first, so the new copy is picked', async () => {
  const w = await gaveUpMemo();
  await w.engine.move(ID, 일상);
  writeFileSync(join(w.root, '일상', 'wiki', 'log.md'), `# log\n${[1, 2, 3].map((k) => `## [2026-10-29] ingest | ${ID} | ${k < 3 ? '실패' : '포기'} ${k}/3 | x\n`).join('')}`);
  assert.deepEqual(await w.engine.move(ID, 스터디), { kind: 'released', domain: 스터디 });
  assert.ok(read(w.root, '스터디/wiki/log.md').endsWith(`## [2026-10-29] ingest | ${ID} | 이동 → 일상 | -\n## [2026-10-29] ingest | ${ID} | 재시도 | -\n`));
  assert.deepEqual(await placed(w.engine, ID), { domain: 스터디, state: 'routed' });
});

test('retry reopens a gave-up memo with its attempts reset, and only a gave-up one', async () => {
  const w = await gaveUpMemo();
  assert.equal(await w.engine.retry(일상, ID), 'not-failed');
  assert.equal(await w.engine.retry(스터디, ID), 'retrying');
  assert.equal(await w.engine.retry(스터디, ID), 'not-failed');
  assert.deepEqual(await run(w.engine, '스터디'), { kind: 'committed', job: { kind: 'ingest', domain: 스터디, id: ID }, verdict: 'unchanged' });
});

test('a move cut off after its copy, or after its line, is finished by the next run in the domain it left', async () => {
  for (const cut of ['after the copy', 'after the line'] as const) {
    const w = await gaveUpMemo();
    const text = renderMemoFile({ ...memo(1, '메모', { domain_hint: '스터디' }), attachments: [] }, { by: 'user', from: 스터디, previous: { by: 'hint' } });
    writeFileSync(join(w.root, '일상', 'raw', `${ID}.md`), text);
    if (cut === 'after the line') writeFileSync(join(w.root, '스터디', 'wiki', 'log.md'), `${read(w.root, '스터디/wiki/log.md')}## [2026-10-29] ingest | ${ID} | 이동 → 일상 | -\n`);
    assert.deepEqual(await placed(w.engine, ID), { domain: 일상, state: 'routed' }, cut);
    assert.deepEqual(await run(w.engine, '스터디'), { kind: 'idle' }, cut);
    assert.equal(exists(w.root, `스터디/raw/${ID}.md`), false, cut);
    assert.equal(read(w.root, '스터디/wiki/log.md').split('이동 → 일상').length, 2, `${cut}: one moved line`);
  }
});

test('a kill anywhere in moving a gave-up memo, and again when the move is tried again after a pass, leaves it in exactly one domain with one moved line', async () => {
  const prep = async () => {
    const w = await gaveUpMemo();
    return { root: w.root, store: w.store };
  };
  const model = fakeModel({});
  const seen = await everyKill({
    fresh: await template(prep),
    act: async (fs, store) => void (await (await engineOn(fs, store, model)).move(ID, 일상)),
    reopen: async (fs, store) => {
      const e = await engineOn(fs, store, model);
      const pass = async () => {
        for (const d of (await e.domains())!) await e.runNext(d, { withModel: false, signal: NO_SIGNAL });
      };
      await pass();
      await e.move(ID, 일상);
      await pass();
    },
    check: async (root, store, where) => {
      const e = await engineOn(nodeFs(root), store, model);
      assert.deepEqual(await placed(e, ID), { domain: 일상, state: 'routed' }, where);
      assert.equal(exists(root, `스터디/raw/${ID}.md`), false, where);
      assert.equal(exists(root, `스터디/raw/${ID}.source.md`), false, where);
      assert.equal(read(root, `일상/raw/${ID}.source.md`), '---\nmemo: x\n---\n본문\n', where);
      assert.equal(read(root, '스터디/wiki/log.md').split('이동 → 일상').length, 2, `${where}: one moved line`);
      assert.equal(store.rows(), 0, where);
    },
  });
  assert.ok(seen > 20, `${seen} kills`);
}, 30_000);

test('a kill anywhere in routing leaves the memo in exactly one place once the router runs again', async () => {
  const prep = async () => {
    const root = await presetWiki('ko');
    const store = memoryJournal();
    await (await engineOn(nodeFs(root), store, fakeModel({}))).accept(memo(1, '메모', { domain_hint: '스터디' }));
    return { root, store };
  };
  const model = fakeModel({});
  await everyKill({
    fresh: await template(prep),
    act: async (fs, store) => void (await (await engineOn(fs, store, model)).routeNext(NO_SIGNAL)),
    reopen: async (fs, store) => void (await (await engineOn(fs, store, model)).routeNext(NO_SIGNAL)),
    check: async (root, store, where) => {
      const e = await engineOn(nodeFs(root), store, model);
      assert.deepEqual(await e.routeNext(NO_SIGNAL), { kind: 'idle' }, where);
      assert.equal(exists(root, `inbox/${ID}.md`), false, where);
      assert.equal(read(root, `스터디/raw/${ID}.md`), renderMemoFile({ ...memo(1, '메모', { domain_hint: '스터디' }), attachments: [] }, { by: 'hint' }), where);
    },
  });
}, 30_000);

/** A turn that waits until the test lets it go. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  let reached!: () => void;
  const waiting = new Promise<void>((r) => (reached = r));
  return { open, waiting, turn: (t: Reply): Reply => (reached(), opened.then(() => t)) };
}

test('a confirm, a move, and a retry complete while an ingest is mid-turn in another domain and a classify is mid-turn', async () => {
  const ingest = gate();
  const classify = gate();
  const w = await gaveUpMemo();
  const root = w.root;
  const store = w.store;
  let classifyCalls = 0;
  const engine = await engineOn(nodeFs(root), store, fakeModel({
    classify: () => (++classifyCalls === 1 ? turn.route('미루기 아카이빙', 0.4, '애매함') : classify.turn(turn.route('일상', 0.9, 'r'))),
    ingest: (_r, n) => (n === 1 ? ingest.turn(turn.write('wiki/x.md', page(validFields(ulid(3), { type: 'me' }), '본문.\n'))) : turn.finish('created')),
  }));
  await engine.accept(memo(2, '애매함'));
  assert.equal((await engine.routeNext(NO_SIGNAL)).kind, 'held');
  await engine.accept(memo(3, '일상 메모', { domain_hint: '일상' }));
  assert.equal((await engine.routeNext(NO_SIGNAL)).kind, 'routed');
  await engine.accept(memo(4, '분류 중'));

  const job = run(engine, '일상');
  const routing = engine.routeNext(NO_SIGNAL);
  await Promise.all([ingest.waiting, classify.waiting]);
  assert.deepEqual(await engine.confirm(ulid(2) as MemoId), { kind: 'released', domain: '미루기 아카이빙' });
  assert.equal(await engine.retry(스터디, ID), 'retrying');
  assert.deepEqual(await engine.move(ID, '미루기 아카이빙' as DomainName), { kind: 'conflict', at: { domain: 스터디, state: 'routed' } });
  ingest.open();
  classify.open();
  assert.equal((await job).kind, 'committed');
  assert.equal((await routing).kind, 'routed');
});
