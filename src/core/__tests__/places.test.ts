import assert from 'node:assert/strict';
import { parseLedger } from '../ledger';
import { locate, memoIds, memoIdsIn, orderKey, placementOf, type DomainPlaces, type Places } from '../places';
import type { DomainName, MemoId } from '../types';

const A = '01JB8ZQ4M3T9X7K2W5R6N8P001' as MemoId;
const 일상 = '일상' as DomainName;
const 스터디 = '스터디' as DomainName;
const 미루기 = '미루기 아카이빙' as DomainName;

const line = (third: string) => `## [2026-10-29] ingest | ${A} | ${third} | -`;
const domain = (d: DomainName, p: { raw?: boolean; hold?: boolean; log?: string[] }): DomainPlaces => ({
  domain: d,
  raw: new Set(p.raw ? [A] : []),
  hold: new Set(p.hold ? [A] : []),
  ledger: parseLedger(['# log', ...(p.log ?? [])].join('\n')),
});
const places = (ds: DomainPlaces[], running: [DomainName, string][] = []): Places => ({ inbox: new Set(), domains: ds, running: new Map(running) });

test('a raw copy with no terminal line is routed, or running while the journal holds its ingest open', () => {
  assert.deepEqual(locate(places([domain(일상, {}), domain(스터디, { raw: true })]), A), { domain: 스터디, state: 'routed' });
  assert.deepEqual(locate(places([domain(스터디, { raw: true })], [[스터디, A]]), A), { domain: 스터디, state: 'running' });
  assert.deepEqual(locate(places([domain(스터디, { raw: true })], [[일상, A]]), A), { domain: 스터디, state: 'routed' }, 'a job in another domain');
  assert.deepEqual(locate(places([domain(스터디, { raw: true, log: [line('새 페이지')] })]), A), { domain: 스터디, state: 'ingested' });
});

test('a raw copy beats a hold copy, and a hold copy alone is held', () => {
  assert.deepEqual(locate(places([domain(일상, { hold: true }), domain(스터디, { raw: true })]), A), { domain: 스터디, state: 'routed' });
  assert.deepEqual(locate(places([domain(일상, {}), domain(스터디, { hold: true })]), A), { domain: 스터디, state: 'held' });
  assert.equal(locate(places([domain(일상, {}), domain(스터디, {})]), A), null);
});

test('a domain the memo moved out of is skipped, and a gave-up copy loses to a live copy elsewhere', () => {
  const gaveUp = [line('실패 1/3'), line('실패 2/3'), line('포기 3/3')];
  assert.deepEqual(locate(places([domain(스터디, { raw: true, log: [...gaveUp, line('이동 → 일상')] }), domain(일상, { raw: true })]), A), { domain: 일상, state: 'routed' });
  assert.deepEqual(locate(places([domain(스터디, { raw: true, log: gaveUp }), domain(일상, { raw: true })]), A), { domain: 일상, state: 'routed' }, 'a move cut off before its line');
  assert.deepEqual(locate(places([domain(스터디, { raw: true, log: gaveUp }), domain(미루기, { hold: true })]), A), { domain: 스터디, state: 'failed' }, 'failed beats a hold copy');
  assert.deepEqual(locate(places([domain(스터디, { raw: true, log: [...gaveUp, line('재시도')] })]), A), { domain: 스터디, state: 'routed' }, 'a retry reopens it');
});

test('memo ids are the names that are exactly <id>.md', () => {
  assert.deepEqual([...memoIdsIn([`${A}.md`, `${A}.source.md`, '.gitkeep', 'notes.md', `${A.toLowerCase()}.md`, 'f47ac10b-58cc-4372-a567-0e02b2c3d479.md'])], [A, 'f47ac10b-58cc-4372-a567-0e02b2c3d479']);
});

test('oldest captured first, by the instant and not the written offset, then by id', () => {
  const keys = [
    orderKey('2026-10-29T09:00:00+09:00', 'B'),
    orderKey('2026-10-29T08:30:00+09:00', 'C'),
    orderKey('2026-10-29T00:00:00Z', 'A'),
  ];
  assert.deepEqual([...keys].sort(), [keys[1], keys[2], keys[0]]);
});

test('a memo\'s placement carries what its ledger says: the retry\'s last failure, the verdict and pages, the give-up, each with its day', () => {
  const B = '01JB8ZQ4M3T9X7K2W5R6N8P002' as MemoId;
  const at = (d: DomainName, log: string[], opts: { raw?: boolean; hold?: boolean } = { raw: true }): DomainPlaces => ({ ...domain(d, { ...opts, log }) });
  const broken = 'broken-link 스터디/wiki/a.md: [[없음]] does not resolve';
  const failure = (attempts: number) => ({ attempts, max: 3, code: 'broken-link', detail: '스터디/wiki/a.md: [[없음]] does not resolve' });
  const inbox: Places = { inbox: new Set([A]), domains: [domain(스터디, {})], running: new Map() };
  assert.deepEqual(placementOf(inbox, A), { state: 'inbox' });
  assert.equal(placementOf(inbox, B), null);
  assert.deepEqual(placementOf(places([domain(스터디, { hold: true })]), A), { state: 'held', domain: 스터디 });
  assert.deepEqual(placementOf(places([at(스터디, [])], [[스터디, A]]), A), { state: 'running', domain: 스터디, retry: null });
  assert.deepEqual(placementOf(places([at(스터디, [`## [2026-10-29] ingest | ${A} | 실패 1/3 | ${broken}`])]), A), { state: 'routed', domain: 스터디, retry: failure(1) });
  const gaveUp = [`## [2026-10-28] ingest | ${A} | 실패 1/3 | ${broken}`, `## [2026-10-28] ingest | ${A} | 실패 2/3 | ${broken}`, `## [2026-10-29] ingest | ${A} | 포기 3/3 | ${broken}`];
  assert.deepEqual(placementOf(places([at(스터디, gaveUp)]), A), { state: 'failed', domain: 스터디, failure: failure(3), finished: { day: '2026-10-29' } });
  assert.deepEqual(placementOf(places([at(스터디, [...gaveUp, line('재시도')])]), A), { state: 'routed', domain: 스터디, retry: null }, 'a retry line resets the attempts');
  assert.deepEqual(placementOf(places([at(스터디, [`## [2026-10-30] ingest | ${A} | 새 페이지 | RAG.md, 인사이트/2026.md`])]), A), {
    state: 'ingested', domain: 스터디, verdict: 'created', pages: ['RAG.md', '인사이트/2026.md'], finished: { day: '2026-10-30' },
  });
  assert.equal(placementOf(places([at(스터디, [...gaveUp, line('이동 → 일상')])]), A), null, 'only where it was moved out of');
});

test('the snapshot names every memo in the inbox, raw/, and hold/, once each', () => {
  const B = '01JB8ZQ4M3T9X7K2W5R6N8P002' as MemoId;
  const p: Places = { inbox: new Set([A]), domains: [{ ...domain(스터디, { raw: true }), hold: new Set([B]) }, domain(일상, { hold: true })], running: new Map() };
  assert.deepEqual([...memoIds(p)].sort(), [A, B]);
});
