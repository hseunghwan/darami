import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendLine, LEDGER_WORDS, parseLedger, readTable, renderLine, type LedgerLine } from '../ledger';
import type { Locale } from '../types';

const fixture = (l: Locale) => readFileSync(join(__dirname, 'fixtures', 'ledger', `${l}.md`), 'utf8');

const failed = (attempt: number, reason: string) => ({ kind: 'attempt-failed', attempt, max: 3, reason, interrupted: false }) as const;
const interrupted = (attempt: number) => ({ kind: 'attempt-failed', attempt, max: 3, reason: 'gateway stopped mid-job', interrupted: true }) as const;
const gaveUp = (reason: string) => ({ kind: 'gave-up', attempt: 3, max: 3, reason }) as const;

test('the Korean log dotoriwiki wrote before its P2 folds to these histories', () => {
  const ledger = parseLedger(fixture('ko'));
  assert.deepEqual(ledger.history('ingest', 'K1'), {
    attempts: 0,
    terminal: { kind: 'applied', verdict: 'created', pages: ['RAG.md', '인사이트/2026.md'], line: 4 },
    lastFailure: gaveUp('frontmatter 스터디/wiki/RAG.md: summary missing'),
  });
  assert.deepEqual(ledger.history('ingest', 'K2').terminal, { kind: 'applied', verdict: 'updated', pages: ['RAG.md'], line: 0 });
  assert.deepEqual(ledger.history('ingest', 'K3').terminal, { kind: 'applied', verdict: 'conflict', pages: ['RAG.md'], line: 0 });
  assert.deepEqual(ledger.history('ingest', 'K4').terminal, { kind: 'applied', verdict: 'unchanged', pages: [], line: 0 });
  assert.deepEqual(ledger.history('ingest', 'K5').terminal, { kind: 'moved', to: '미루기 아카이빙', line: 1 });
  assert.deepEqual(ledger.history('file-answer', 'K6').terminal, { kind: 'applied', verdict: 'saved', pages: ['answers/2026-10-31 RAG.md'], line: 0 });
  assert.deepEqual(ledger.history('ingest', 'K6'), { attempts: 0, terminal: null, lastFailure: null }, 'kind is part of the key');
  assert.equal(ledger.lineCount('ingest', 'K1'), 5);
  assert.equal(ledger.failedCount(), 0);
});

test('the English log folds to the same histories, job for job', () => {
  const ko = parseLedger(fixture('ko'));
  const en = parseLedger(fixture('en'));
  for (const [k, e] of [['K2', 'E2'], ['K3', 'E3'], ['K4', 'E4']] as const) assert.deepEqual(en.history('ingest', e), ko.history('ingest', k));
  assert.deepEqual(en.history('ingest', 'E1'), {
    attempts: 0,
    terminal: { kind: 'applied', verdict: 'created', pages: ['RAG.md', 'insights/2026.md'], line: 4 },
    lastFailure: gaveUp('frontmatter learning/wiki/RAG.md: summary missing'),
  });
  assert.deepEqual(en.history('ingest', 'E5').terminal, { kind: 'moved', to: 'someday', line: 1 });
  assert.deepEqual(en.history('file-answer', 'E6'), ko.history('file-answer', 'K6'));
  assert.equal(en.lineCount('ingest', 'E1'), 5);
});

const job: LedgerLine[] = [
  { date: '2026-10-29', job: 'ingest', id: 'A', outcome: failed(1, 'broken-link x.md: [[y]] does not resolve') },
  { date: '2026-10-29', job: 'ingest', id: 'A', outcome: interrupted(2) },
  { date: '2026-10-29', job: 'ingest', id: 'A', outcome: gaveUp('empty x.md: page has no body') },
  { date: '2026-10-30', job: 'ingest', id: 'A', outcome: { kind: 'retry' } },
  { date: '2026-10-30', job: 'ingest', id: 'A', outcome: { kind: 'applied', verdict: 'updated', pages: ['RAG.md'] } },
  { date: '2026-10-30', job: 'ingest', id: 'B', outcome: gaveUp('llm : edit run timed out') },
  { date: '2026-10-31', job: 'ingest', id: 'B', outcome: { kind: 'moved', to: '미루기 아카이빙' } },
  { date: '2026-10-31', job: 'file-answer', id: 'C', outcome: { kind: 'applied', verdict: 'saved', pages: [] } },
];

test('rendered lines round-trip in each locale, both fold alike, and Korean is what dotoriwiki wrote before its P2', () => {
  const ko = job.reduce((t, l) => appendLine('ko', t, l), '# log\n');
  const en = job.reduce((t, l) => appendLine('en', t, l), '# log\n');
  for (const [kind, id] of [['ingest', 'A'], ['ingest', 'B'], ['file-answer', 'C']] as const) {
    assert.deepEqual(parseLedger(en).history(kind, id), parseLedger(ko).history(kind, id));
  }
  assert.deepEqual(parseLedger(ko).history('ingest', 'A'), { attempts: 0, terminal: { kind: 'applied', verdict: 'updated', pages: ['RAG.md'], line: 4 }, lastFailure: job[2]!.outcome });
  assert.deepEqual(ko.split('\n').slice(1, -1), [
    '## [2026-10-29] ingest | A | 실패 1/3 | broken-link x.md: [[y]] does not resolve',
    '## [2026-10-29] ingest | A | 중단 2/3 | gateway stopped mid-job',
    '## [2026-10-29] ingest | A | 포기 3/3 | empty x.md: page has no body',
    '## [2026-10-30] ingest | A | 재시도 | -',
    '## [2026-10-30] ingest | A | 기존 페이지 수정 | RAG.md',
    '## [2026-10-30] ingest | B | 포기 3/3 | llm : edit run timed out',
    '## [2026-10-31] ingest | B | 이동 → 미루기 아카이빙 | -',
    '## [2026-10-31] file-answer | C | 저장 | -',
  ]);
  assert.equal(renderLine('en', job[2]!), '## [2026-10-29] ingest | A | gave up 3/3 | empty x.md: page has no body');
  assert.equal(renderLine('en', job[6]!), '## [2026-10-31] ingest | B | moved → 미루기 아카이빙 | -');
});

test('a locale change mid-history keeps folding: a Korean give-up, then English lines', () => {
  const text = [
    '# log',
    '## [2026-10-29] ingest | A | 실패 1/3 | empty x.md: page has no body',
    '## [2026-10-29] ingest | A | 포기 3/3 | empty x.md: page has no body',
    '## [2026-11-02] ingest | A | retry | -',
    '## [2026-11-02] ingest | A | failed 1/3 | broken-link x.md: [[y]] does not resolve',
    '## [2026-11-02] ingest | A | new page | x.md',
    '',
  ].join('\n');
  const ledger = parseLedger(text);
  assert.deepEqual(ledger.history('ingest', 'A'), {
    attempts: 1,
    terminal: { kind: 'applied', verdict: 'created', pages: ['x.md'], line: 4 },
    lastFailure: failed(1, 'broken-link x.md: [[y]] does not resolve'),
  });
  assert.equal(ledger.failedCount(), 0);
});

test('names that look like ledger words stay names', () => {
  for (const to of ['retry', 'gave up', '새 페이지', '이동', 'a → b']) {
    const line: LedgerLine = { date: '2026-10-30', job: 'ingest', id: 'M', outcome: { kind: 'moved', to } };
    const text = ['포기 3/3', 'gave up 3/3'].map((w) => `## [2026-10-29] ingest | M | ${w} | x`).join('\n');
    for (const l of ['ko', 'en'] as const) assert.deepEqual(parseLedger(appendLine(l, text, line)).history('ingest', 'M').terminal, { kind: 'moved', to, line: 2 }, `${l} ${to}`);
  }
  const pages = ['실패 1/3.md', 'retry.md', 'gave up 3|3.md'];
  const applied: LedgerLine = { date: '2026-10-30', job: 'ingest', id: 'P', outcome: { kind: 'applied', verdict: 'created', pages } };
  for (const l of ['ko', 'en'] as const) assert.deepEqual(parseLedger(appendLine(l, '', applied)).history('ingest', 'P').terminal, { kind: 'applied', verdict: 'created', pages, line: 0 });
});

test('free text cannot forge a state change', () => {
  const sneaky: LedgerLine = { date: '2026-10-29', job: 'ingest', id: 'D', outcome: failed(1, 'bad\n## [2026-10-29] ingest | D | 새 페이지 | x.md') };
  const text = appendLine('ko', '# log\n', sneaky);
  assert.equal(text.split('\n').length, 3, 'a reason with a newline stays on one line');
  assert.equal(parseLedger(text).history('ingest', 'D').lastFailure?.reason, 'bad ## [2026-10-29] ingest | D | 새 페이지 | x.md');
  assert.equal(parseLedger(text).history('ingest', 'D').terminal, null);
});

test('text the engine never wrote stays applied, and an unknown <word> k/N is inert but counted', () => {
  const text = [
    '## [2025-12-01] ingest | L | 기존 내용과 충돌 | RAG.md',
    '## [2027-01-01] ingest | N | 失敗 1/3 | something',
    '## [2027-01-01] ingest | N | failed 2/3 | empty x.md: page has no body',
    '## [2027-01-01] ingest | N | new page | x.md',
  ].join('\n');
  const ledger = parseLedger(text);
  assert.deepEqual(ledger.history('ingest', 'L').terminal, { kind: 'applied', verdict: { unknown: '기존 내용과 충돌' }, pages: ['RAG.md'], line: 0 });
  assert.deepEqual(ledger.history('ingest', 'N'), { attempts: 1, terminal: { kind: 'applied', verdict: 'created', pages: ['x.md'], line: 2 }, lastFailure: failed(2, 'empty x.md: page has no body') });
  assert.equal(ledger.lineCount('ingest', 'N'), 3, 'the inert line still counts as one of the job\'s lines');
});

test('the read table refuses a word with two meanings across locales, or a verdict shaped like an attempt', () => {
  assert.throws(() => readTable([LEDGER_WORDS.ko, { ...LEDGER_WORDS.en, retry: '포기' }]), /two meanings/);
  assert.throws(() => readTable([{ ...LEDGER_WORDS.en, verdicts: { ...LEDGER_WORDS.en.verdicts, conflict: '실패' } }, LEDGER_WORDS.ko]), /two meanings/);
  assert.throws(() => readTable([{ ...LEDGER_WORDS.en, verdicts: { ...LEDGER_WORDS.en.verdicts, saved: 'saved 1/2' } }]), /attempt or a move/);
  assert.throws(() => readTable([{ ...LEDGER_WORDS.en, retry: 'go → on' }]), /attempt or a move/);
  assert.doesNotThrow(() => readTable([LEDGER_WORDS.en, { ...LEDGER_WORDS.ko, verdicts: { ...LEDGER_WORDS.ko.verdicts, conflict: 'conflict' } }]), 'two locales may share a word with one meaning');
});

test('a job\'s line keeps the date it was written on, counted as history counts lines', () => {
  const ledger = parseLedger('# log\n## [2026-10-28] ingest | A | 실패 1/3 | x\n## [2026-10-29] ingest | B | 새 페이지 | -\n## [2026-10-30] ingest | A | 새 페이지 | a.md\n');
  const t = ledger.history('ingest', 'A').terminal!;
  assert.equal(ledger.dateOf('ingest', 'A', t.line), '2026-10-30');
  assert.equal(ledger.dateOf('ingest', 'A', 0), '2026-10-28');
  assert.equal(ledger.dateOf('ingest', 'A', 2), null);
  assert.equal(ledger.dateOf('file-answer', 'A', 0), null);
});
