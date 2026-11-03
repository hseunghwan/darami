import assert from 'node:assert/strict';
import { memoDirOf, parseWikiPath, paths, placeForJob, resolvePath, ROOT, shownPath, touchedBy, type WikiPath } from '../layout';
import type { DomainName } from '../types';

const 스터디 = '스터디' as DomainName;
const NFD = '스터디'.normalize('NFD');

test('a stored path is a WikiPath only when it already follows the rule', () => {
  for (const ok of ['', 'CLAUDE.md', '스터디/wiki/log.md', 'inbox/.rejected/x.md']) assert.equal(parseWikiPath(ok), ok, JSON.stringify(ok));
  for (const bad of ['/x', 'x/', 'a//b', './a', 'a/./b', 'a/../b', '..', 'a\\b', 'a\0b', `${NFD}/CLAUDE.md`]) assert.equal(parseWikiPath(bad), null, JSON.stringify(bad));
});

test('a written path resolves against its folder and never above the root', () => {
  const cases: [string, string, string | null][] = [
    ['스터디', '../_schema/공통규칙.md', '_schema/공통규칙.md'],
    ['스터디', '../../x.md', null],
    ['', '/etc/passwd', null],
    ['', '..', null],
    ['스터디', '..', ''],
    ['', './a//b/', 'a/b'],
    ['스터디', 'wiki/a/../b.md', '스터디/wiki/b.md'],
    ['', `${NFD}/CLAUDE.md`, '스터디/CLAUDE.md'],
    ['', 'a\\b', null],
    ['', 'a\0b', null],
  ];
  for (const [from, target, want] of cases) assert.equal(resolvePath(parseWikiPath(from)!, target), want, `${from} + ${target}`);
});

test('every place of the folder contract is a WikiPath', () => {
  assert.equal(paths.domainSchema(스터디), '스터디/CLAUDE.md');
  assert.equal(paths.log(스터디), '스터디/wiki/log.md');
  assert.equal(paths.answersInbox(스터디), 'inbox/answers/스터디');
  const all: WikiPath[] = Object.values(paths).map((v) => (typeof v === 'function' ? v(스터디) : v));
  assert.ok(all.length > 10);
  for (const p of [ROOT, ...all]) assert.equal(parseWikiPath(p), p, p);
});

test("a job's model may write pages under its own wiki/, add to _review.md, read what it needs, and nothing else", () => {
  const declared = ['일상', 스터디, '미루기 아카이빙'] as DomainName[];
  const cases: [string, string, string | null][] = [
    ['wiki/RAG.md', 'page', '스터디/wiki/RAG.md'],
    ['./wiki//인사이트/2026.md', 'page', '스터디/wiki/인사이트/2026.md'],
    ['wiki/answers/2026-10-29 Q.md', 'page', '스터디/wiki/answers/2026-10-29 Q.md'],
    [`../${NFD}/wiki/RAG.md`, 'page', '스터디/wiki/RAG.md'],
    ['wiki/_review.md', 'review', '스터디/wiki/_review.md'],
    ['wiki/_REVIEW.md', 'review', '스터디/wiki/_REVIEW.md'],
    ['wiki/index.md', 'server', '스터디/wiki/index.md'],
    ['wiki/LOG.md', 'server', '스터디/wiki/LOG.md'],
    ['raw/01JB8ZQ4M3T9X7K2W5R6N8P001.md', 'readable', '스터디/raw/01JB8ZQ4M3T9X7K2W5R6N8P001.md'],
    ['CLAUDE.md', 'readable', '스터디/CLAUDE.md'],
    ['../CLAUDE.md', 'readable', 'CLAUDE.md'],
    ['../dotoriwiki.yaml', 'readable', 'dotoriwiki.yaml'],
    ['../_schema/공통규칙.md', 'readable', '_schema/공통규칙.md'],
    ['../일상/wiki/ME.md', 'readable', '일상/wiki/ME.md'],
    ['../일상/raw/x.md', 'outside', '일상/raw/x.md'],
    ['hold/x.md', 'outside', '스터디/hold/x.md'],
    ['../inbox/x.md', 'outside', 'inbox/x.md'],
    ['../_originals/x.jpg', 'outside', '_originals/x.jpg'],
    ['../없는 도메인/wiki/x.md', 'outside', '없는 도메인/wiki/x.md'],
    ['wiki/a.txt', 'outside', '스터디/wiki/a.txt'],
    ['wiki/.obsidian/x.md', 'outside', '스터디/wiki/.obsidian/x.md'],
    ['wiki', 'outside', '스터디/wiki'],
    ['..', 'outside', ''],
    ['wiki/../../../x.md', 'outside', null],
    ['/etc/x.md', 'outside', null],
    ['wiki/a\\b.md', 'outside', null],
  ];
  for (const [target, kind, path] of cases) assert.deepEqual(placeForJob(스터디, declared, target), { kind, path }, target);
});

test('a path is shown to the model relative to its domain folder', () => {
  assert.equal(shownPath(스터디, '스터디/wiki/RAG.md' as WikiPath), 'wiki/RAG.md');
  assert.equal(shownPath(스터디, '일상/wiki/ME.md' as WikiPath), '../일상/wiki/ME.md');
  assert.equal(shownPath(스터디, '스터디 2/wiki/x.md' as WikiPath), '../스터디 2/wiki/x.md');
});

test('memo folders are the inbox and each domain\'s raw/ and hold/, and a ledger is a domain\'s wiki/log.md', () => {
  const at = (p: string) => p as WikiPath;
  assert.deepEqual(memoDirOf(at('inbox')), { kind: 'inbox' });
  assert.deepEqual(memoDirOf(at('스터디/raw')), { kind: 'raw', domain: '스터디' });
  assert.deepEqual(memoDirOf(at('미루기 아카이빙/hold')), { kind: 'hold', domain: '미루기 아카이빙' });
  for (const not of ['inbox/answers/스터디', 'inbox/.rejected', '스터디/wiki', '스터디/raw/x', '.trash/raw', '_attachments', '']) assert.equal(memoDirOf(at(not)), null, not);
  assert.deepEqual(touchedBy(at('스터디/hold/a.md')), { kind: 'memo', dir: '스터디/hold', name: 'a.md' });
  assert.deepEqual(touchedBy(at('inbox/a.md')), { kind: 'memo', dir: 'inbox', name: 'a.md' });
  assert.deepEqual(touchedBy(at('스터디/wiki/log.md')), { kind: 'ledger' });
  for (const not of ['스터디/wiki/index.md', '스터디/wiki/sub/log.md', 'inbox/answers/스터디/a.md', 'log.md', 'CLAUDE.md']) assert.equal(touchedBy(at(not)), null, not);
});
