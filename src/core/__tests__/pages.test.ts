import assert from 'node:assert/strict';
import { check, namesOf, parseMemo, utf8Length, type Change, type CheckInput } from '../pages';
import { page, ulid, validFields } from './helpers';

const 스터디 = '스터디';
const 미루기 = '미루기 아카이빙';
const 일상 = '일상';
/** 스터디's page types in presets/ko/dotoriwiki.yaml, and `answer`, which every domain has. */
const TYPES = new Set(['concept', 'case', 'project', 'insight', 'answer']);

/**
 * check() for one 스터디 job that left `files` (paths under 스터디/) changed. Other domains' names
 * are what was there before the job: 미루기 holds a page an earlier job filed, and 일상's new page
 * was written after the job's names were taken.
 */
function checkJob(files: readonly (readonly [string, string])[], extra: Partial<CheckInput> = {}) {
  const changes: Change[] = files.map(([p]) => ({ path: `${스터디}/${p}`, status: p === 'wiki/_review.md' ? 'modified' : 'added' }));
  const under = files.map(([p]) => p.replace(/^wiki\//, ''));
  return check({
    domain: 스터디,
    changes,
    contents: new Map(files.map(([p, c]) => [`${스터디}/${p}`, c])),
    reviewBefore: null,
    names: new Map([
      [일상, namesOf(['index.md', 'log.md'])],
      [미루기, namesOf(['index.md', 'log.md', '항목/기존 항목.md'])],
      [스터디, namesOf(['index.md', 'log.md', ...under])],
    ]),
    allowedTypes: TYPES,
    outsideWrites: [],
    modifiedInputs: [],
    attachments: new Set(),
    ...extra,
  });
}

test('page checks: required fields, allowed types, links, cross-domain links, empty files', () => {
  const cases: [string, (id: string) => [string, string][], string[]][] = [
    ['summary missing', (id) => [['wiki/a.md', page({ ...validFields(id), summary: '' })]], ['frontmatter']],
    ['no frontmatter', () => [['wiki/a.md', '그냥 글\n']], ['frontmatter']],
    ['type from another domain table', (id) => [['wiki/a.md', page({ ...validFields(id), type: 'item' })]], ['type']],
    ['link to a missing page', (id) => [['wiki/a.md', page(validFields(id), '[[없는 페이지]]\n')]], ['broken-link']],
    ['empty file', () => [['wiki/a.md', '']], ['empty']],
    ['page without body', (id) => [['wiki/a.md', page(validFields(id), '')]], ['empty']],
    ['edit to an existing _review.md line', () => [['wiki/_review.md', '# 바뀜\n']], ['append-only']],
  ];
  let n = 10;
  for (const [name, files, rules] of cases) {
    n++;
    const reviewBefore = name.includes('_review.md') ? '# 검토할 것\n' : null;
    assert.deepEqual(checkJob(files(ulid(n)), { reviewBefore }).map((p) => p.rule), rules, name);
  }

  const cross = checkJob([['wiki/b.md', page(validFields(ulid(51)), '[[미루기 아카이빙/wiki/항목/기존 항목]] [[일상/wiki/주제/새 주제]]\n')]]);
  assert.deepEqual(cross.map((p) => p.detail), ['[[일상/wiki/주제/새 주제]] does not resolve'], 'the page in 미루기 resolves; the page 일상 did not have yet does not');
});

test('wikilink syntax quoted in code is not checked as a link', () => {
  const files: [string, string][] = [['wiki/a.md', page(validFields(ulid(1)), 'YAML 중첩 배열 `[[...]]` 와 ``[[없는 페이지]]``\n\n```\n[[코드 블록 안]]\n```\n')]];
  assert.deepEqual(checkJob(files), [], 'code spans and fences hold no links');
});

test('utf8Length counts what Buffer.byteLength counts', () => {
  for (const s of ['', 'memo', '메모 한 줄', '🌰 도토리', 'a\uD800b', '\uDC00', 'x\uD83C']) assert.equal(utf8Length(s), Buffer.byteLength(s), JSON.stringify(s));
});

test('a memo may hold 64 KiB of UTF-8 and not one byte more, counted in bytes, not characters', () => {
  const fields = { id: ulid(1), captured_at: '2026-10-29T08:01:00+09:00', tz: 'Asia/Seoul', source: 'typed' };
  const at = `${'가'.repeat(21_845)}a`;
  assert.equal(Buffer.byteLength(at), 64 * 1024);
  assert.ok(parseMemo({ ...fields, text: at }).ok);
  assert.deepEqual(parseMemo({ ...fields, text: `${at}b` }), { ok: false, detail: 'text: over 64 KiB' });
  assert.deepEqual(parseMemo({ ...fields, text: '가'.repeat(21_846) }), { ok: false, detail: 'text: over 64 KiB' }, 'fewer characters than 64 Ki, more bytes');
});
