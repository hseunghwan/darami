import assert from 'node:assert/strict';
import { parseWikiPath, paths, resolvePath, ROOT, type WikiPath } from '../layout';
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
