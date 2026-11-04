import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FetchSource } from '../../core/sources';
import type { DomainName } from '../../core/types';
import { nodeFs } from '../../fs/node';
import { memo, page, ulid, validFields } from '../../core/__tests__/helpers';
import { fakeModel, turn, type Script } from '../../agent/__tests__/fake-model';
import { engineOn, fakeFetchSource, Killed, memoryJournal, NO_SIGNAL, presetWiki, read, run, type Ports } from './harness';

const 스터디 = '스터디' as DomainName;
const ID = ulid(1);
const SIDECAR = `스터디/raw/${ID}.source.md`;
const LOG = '스터디/wiki/log.md';
const linked = () => memo(1, '읽어볼 글 https://example.com/a', { domain_hint: '스터디' });
const good = page(validFields(ID), '본문.\n');
const ok = (url: string) => ({ kind: 'article' as const, status: 'ok' as const, title: `제목 ${url}`, text: `본문 ${url}` });
const WANT = `---\nmemo: ${ID}\nfetched_at: 2026-10-29T09:00:00+09:00\nsources:\n  - url: https://example.com/a\n    kind: article\n    status: ok\n    title: 제목 https://example.com/a\n    detail: null\n---\n\n## https://example.com/a\n\n본문 https://example.com/a\n`;

/** A routed memo with one link, on an engine whose model and fetcher the test picks. */
async function routed(script: Script, ports: Ports = {}) {
  const root = await presetWiki('ko');
  const store = memoryJournal();
  const model = fakeModel(script);
  const open = (p: Ports = ports) => engineOn(nodeFs(root), store, model, [], undefined, undefined, p);
  const engine = await open();
  await engine.accept(linked());
  await engine.routeNext(NO_SIGNAL);
  return { root, model, engine, open };
}

const prompts = (m: ReturnType<typeof fakeModel>) => m.requests.filter((r) => r.role === 'ingest' && r.input.length === 1).map((r) => JSON.stringify(r.input[0]));

test('a link is fetched once in the memo\'s life: the sidecar outlives a failed attempt, and the retry reads it', async () => {
  const fetchSource = fakeFetchSource(ok);
  let attempt = 0;
  const w = await routed({ ingest: (_r, n) => (n === 1 ? (attempt++ === 0 ? turn.write('wiki/a.md', page(validFields(ID), '[[없음]]\n')) : turn.write('wiki/a.md', good)) : turn.finish('created')) }, { fetchSource });
  assert.equal((await run(w.engine, 스터디)).kind, 'retrying');
  assert.equal(read(w.root, SIDECAR), WANT, 'the rollback leaves the sidecar');
  assert.equal((await run(w.engine, 스터디)).kind, 'committed');
  assert.deepEqual(fetchSource.calls, ['https://example.com/a']);
  for (const p of prompts(w.model)) assert.match(p, new RegExp(`raw/${ID}\\.source\\.md`));
});

test('a kill after the fetch keeps the sidecar through recovery, and the next attempt fetches nothing', async () => {
  const fetchSource = fakeFetchSource(ok);
  let killed = false;
  const w = await routed({
    ingest: (_r, n) => {
      if (!killed) {
        killed = true;
        throw new Killed('the model call');
      }
      return n === 1 ? turn.write('wiki/a.md', good) : turn.finish('created');
    },
  }, { fetchSource });
  await assert.rejects(run(w.engine, 스터디), Killed);
  const again = await w.open();
  assert.match(read(w.root, LOG), /중단 1\/3/);
  assert.equal(read(w.root, SIDECAR), WANT);
  assert.equal((await run(again, 스터디)).kind, 'committed');
  assert.deepEqual(fetchSource.calls, ['https://example.com/a']);
});

test('an empty sidecar is filled, and one cut off part way is fetched again', async () => {
  for (const cut of ['', WANT.slice(0, 40)]) {
    const fetchSource = fakeFetchSource(ok);
    const w = await routed({ ingest: (_r, n) => (n === 1 ? turn.write('wiki/a.md', good) : turn.finish('created')) }, { fetchSource });
    writeFileSync(join(w.root, ...SIDECAR.split('/')), cut);
    assert.equal((await run(w.engine, 스터디)).kind, 'committed', JSON.stringify(cut));
    assert.equal(read(w.root, SIDECAR), WANT);
    assert.equal(fetchSource.calls.length, 1);
  }
});

test('offline, the job waits with nothing written and no attempt spent, and files the memo with its sidecar once the network is back', async () => {
  let up = false;
  const fetchSource = fakeFetchSource((url) => (up ? ok(url) : 'offline'));
  const w = await routed({ ingest: (_r, n) => (n === 1 ? turn.write('wiki/a.md', good) : turn.finish('created')) }, { fetchSource });
  const r = await run(w.engine, 스터디);
  assert.equal(r.kind, 'unavailable');
  assert.equal(r.kind === 'unavailable' && r.unavailable.cause, 'network');
  assert.equal(existsSync(join(w.root, ...SIDECAR.split('/'))), false);
  assert.equal(read(w.root, LOG), '# log\n');
  assert.deepEqual(prompts(w.model), [], 'no model call');
  up = true;
  assert.equal((await run(w.engine, 스터디)).kind, 'committed');
  assert.equal(read(w.root, SIDECAR), WANT);
  assert.match(read(w.root, LOG), /ingest \| [^|]+ \| 새 페이지 \| a\.md\n$/);
});

test('leaving the foreground mid-fetch cancels the job and keeps nothing the fetch brought', async () => {
  const abort = new AbortController();
  const fetchSource: FetchSource = async (url) => (abort.abort(), ok(url));
  const w = await routed({}, { fetchSource });
  assert.equal((await w.engine.runNext(스터디, { withModel: true, signal: abort.signal })).kind, 'cancelled');
  assert.equal(existsSync(join(w.root, ...SIDECAR.split('/'))), false);
  assert.equal(read(w.root, LOG), '# log\n');
});

test('a fetcher that throws fails the attempt as interrupted, as dotoriwiki\'s did', async () => {
  const w = await routed({}, { fetchSource: async () => Promise.reject(new Error('a bug')) });
  await assert.rejects(run(w.engine, 스터디), /a bug/);
  await w.open({ fetchSource: fakeFetchSource(ok) });
  assert.match(read(w.root, LOG), /중단 1\/3/);
});
