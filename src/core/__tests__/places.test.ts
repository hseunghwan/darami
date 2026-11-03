import assert from 'node:assert/strict';
import { parseLedger } from '../ledger';
import { locate, memoIdsIn, orderKey, type DomainPlaces, type Places } from '../places';
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
