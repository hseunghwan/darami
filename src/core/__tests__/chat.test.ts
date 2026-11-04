import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { answerId, chatTitle, citationsOf, historyOf, HISTORY_CHARS, linkedDomains, linksOf, parseChatId, rememberId, targetKey, targetOf, type ChatId } from '../chat';
import { chatPlaceOf, chatRoots, placeForChat, type WikiPath } from '../layout';
import { parseLedger } from '../ledger';
import { indexEntries, namesOf, parseAnswerId, parseMemoId, type PageNameIndex } from '../pages';
import { answerIdsIn, answerPlacements } from '../places';
import type { AnswerId, ChatTarget, DomainName } from '../types';

const 스터디 = '스터디' as DomainName;
const 일상 = '일상' as DomainName;
const 미루기 = '미루기 아카이빙' as DomainName;
const DECLARED = [스터디, 일상, 미루기];
const ROOT_CHAT: ChatTarget = { kind: 'root' };
const 스터디_CHAT: ChatTarget = { kind: 'domain', domain: 스터디 };
const CHAT = parseChatId('5D2C7A9E-1F3B-4C8D-9E0A-1B2C3D4E5F60')!;

test('a chat reads every declared wiki, the root rules, and the schema, plus its own CLAUDE.md, and nothing else', () => {
  const readable = ['스터디/wiki/RAG.md', '일상/wiki/개념/ME.md', '미루기 아카이빙/wiki/index.md', '스터디/wiki/answers/a.md', 'CLAUDE.md', 'dotoriwiki.yaml', '_schema/공통규칙.md'];
  const outside = [
    '스터디/raw/01JB.md', '스터디/hold/01JB.md', 'inbox/01JB.md', 'inbox/answers/스터디/a.md', '_originals/a.jpg', '_attachments/a.jpg',
    '스터디/wiki/.obsidian/x.md', '.trash/x.md', '없음/wiki/x.md', '스터디/wiki', '_schema', '', '스터디', 'presets/x.md', '스터디/RAW/x.md',
  ];
  for (const target of [ROOT_CHAT, 스터디_CHAT]) {
    for (const p of readable) assert.equal(placeForChat(target, DECLARED, p).kind, 'readable', `${target.kind} ${p}`);
    for (const p of outside) assert.equal(placeForChat(target, DECLARED, p).kind, 'outside', `${target.kind} ${p}`);
    for (const p of ['../x.md', '/etc/hosts', '스터디/wiki/../../../x', 'a\\b']) assert.deepEqual(placeForChat(target, DECLARED, p), { kind: 'outside', path: null }, p);
    assert.equal(placeForChat(target, DECLARED, '스터디/wiki/../raw/a.md').kind, 'outside', 'resolved before it is judged');
    assert.equal(placeForChat(target, DECLARED, '일상/CLAUDE.md').kind, 'outside', "another domain's CLAUDE.md");
  }
  assert.equal(placeForChat(스터디_CHAT, DECLARED, '스터디/CLAUDE.md').kind, 'readable');
  assert.equal(placeForChat(ROOT_CHAT, DECLARED, '스터디/CLAUDE.md').kind, 'outside', 'a root chat reads no domain CLAUDE.md');
  assert.equal(chatPlaceOf(스터디_CHAT, DECLARED, '스터디/wiki/RAG.md' as WikiPath).kind, 'readable');
  assert.deepEqual(chatRoots(DECLARED), ['스터디/wiki', '일상/wiki', '미루기 아카이빙/wiki', '_schema']);
});

/** 스터디 has RAG and 개념/청크; 일상 has ME. */
const NAMES: PageNameIndex = new Map([
  [스터디, namesOf(['RAG.md', '개념/청크.md', 'index.md'])],
  [일상, namesOf(['ME.md'])],
]);

test('a domain chat cites pages that exist, bare or explicit, deduped first seen first, with the page as written', () => {
  const answer = '[[RAG]] and [[스터디/wiki/RAG]] [[일상/wiki/ME]] [[없음]] `[[개념/청크]]` [[RAG|라벨]] [[청크]] [[nowhere/wiki/x]]\n```\n[[일상/wiki/ME]]\n```';
  assert.deepEqual(citationsOf(answer, 스터디_CHAT, NAMES, DECLARED), [
    { domain: 스터디, page: 'RAG' },
    { domain: 일상, page: 'ME' },
    { domain: 스터디, page: '청크' },
  ]);
  assert.deepEqual(linkedDomains(answer, 스터디_CHAT, DECLARED), [스터디, 일상]);
});

test('a root chat cites only domain/wiki/page links of declared domains', () => {
  const answer = '[[RAG]] [[일상/wiki/ME]] [[nowhere/wiki/x]] [[스터디/wiki/RAG]] [[스터디/wiki/없음]]';
  assert.deepEqual(citationsOf(answer, ROOT_CHAT, NAMES, DECLARED), [{ domain: 일상, page: 'ME' }, { domain: 스터디, page: 'RAG' }]);
  assert.deepEqual(linkedDomains(answer, ROOT_CHAT, DECLARED), [일상, 스터디]);
  assert.deepEqual(citationsOf('no links at all', ROOT_CHAT, NAMES, DECLARED), []);
});

test("an answer's links open only its citations, and a page's open every page they name", () => {
  const answer = '[[RAG|검색]] [[스터디/wiki/RAG]] [[없음]] [[일상/wiki/ME#a]]';
  const cited = citationsOf(answer, 스터디_CHAT, NAMES, DECLARED);
  assert.deepEqual([...linksOf(answer, 스터디, DECLARED, cited)], [
    ['RAG', { domain: 스터디, page: 'RAG' }],
    ['스터디/wiki/RAG', { domain: 스터디, page: 'RAG' }],
    ['일상/wiki/ME', { domain: 일상, page: 'ME' }],
  ]);
  assert.deepEqual([...linksOf('[[없음]] [[ME]]', 일상, DECLARED, null)], [['없음', { domain: 일상, page: '없음' }], ['ME', { domain: 일상, page: 'ME' }]]);
  assert.deepEqual([...linksOf('[[없음]] [[일상/wiki/ME]]', null, DECLARED, null)], [['일상/wiki/ME', { domain: 일상, page: 'ME' }]]);
});

test("Save answer's id is dotoriwiki's: the chat's first 24 characters and the turn as 12 hex digits", () => {
  assert.equal(CHAT, '5d2c7a9e-1f3b-4c8d-9e0a-1b2c3d4e5f60');
  assert.equal(answerId(CHAT, 0), '5d2c7a9e-1f3b-4c8d-9e0a-000000000000');
  assert.equal(answerId(CHAT, 26), '5d2c7a9e-1f3b-4c8d-9e0a-00000000001a');
  assert.equal(parseAnswerId(answerId(CHAT, 3)), answerId(CHAT, 3));
  assert.equal(parseChatId('not a uuid'), null);
});

test("Remember's id is fixed per turn, a memo id, and never one of Save answer's", () => {
  assert.equal(rememberId(CHAT, 0), '5d2c7a9e-1f3b-4c8d-9e0a-800000000000');
  assert.equal(rememberId(CHAT, 1), rememberId(CHAT, 1));
  assert.notEqual(rememberId(CHAT, 1), rememberId(CHAT, 2));
  assert.equal(parseMemoId(rememberId(CHAT, 7)), rememberId(CHAT, 7));
  for (let n = 0; n < 50; n++) assert.notEqual(rememberId(CHAT, n) as string, answerId(CHAT, n) as string);
});

test('a title is the first question in 40 code points, 39 and an ellipsis when cut', () => {
  assert.equal(chatTitle('  RAG에서\n알아낸   게 뭐였지?  '), 'RAG에서 알아낸 게 뭐였지?');
  const forty = '가'.repeat(38) + '🌰😀';
  assert.equal(chatTitle(forty), forty, '40 code points stay, emoji counted once');
  assert.equal(chatTitle(`${forty}끝`), `${'가'.repeat(38)}🌰…`);
});

test('a target is stored as its domain, and a domain no longer declared reads as none', () => {
  assert.equal(targetKey(ROOT_CHAT), null);
  assert.equal(targetKey(스터디_CHAT), '스터디');
  assert.deepEqual(targetOf(null, DECLARED), ROOT_CHAT);
  assert.deepEqual(targetOf('스터디', DECLARED), 스터디_CHAT);
  assert.equal(targetOf('없음', DECLARED), null);
  assert.deepEqual(targetOf('없음', null), { kind: 'domain', domain: '없음' });
});

test('history keeps answered turns, newest first in, oldest first out, under the cap', () => {
  const turns = [
    { question: 'q1', answer: 'a1' },
    { question: 'failed', answer: null },
    { question: 'q2', answer: 'x'.repeat(HISTORY_CHARS - 6) },
    { question: 'q3', answer: 'a3' },
  ];
  assert.deepEqual(historyOf(turns), [{ question: 'q2', answer: 'x'.repeat(HISTORY_CHARS - 6) }, { question: 'q3', answer: 'a3' }]);
  assert.deepEqual(historyOf(turns.slice(0, 2)), [{ question: 'q1', answer: 'a1' }]);
});

test("index.md's entries are its pages' link targets and summaries", () => {
  const index = readFileSync(join(__dirname, 'fixtures', 'made-by-dotoriwiki', '스터디', 'wiki', 'index.md'), 'utf8');
  assert.deepEqual(indexEntries(index), [
    { target: '스터디/wiki/RAG', summary: '청크 크기와 검색' },
    { target: '스터디/wiki/인사이트/2026', summary: '짧은 깨달음' },
    { target: '스터디/wiki/answers/2026-10-29 RAG에서 알아낸 게 뭐였지', summary: 'RAG에서 알아낸 게 뭐였지?' },
  ]);
  assert.deepEqual(indexEntries('- [[a/wiki/b|b]]\n- plain\n## x'), [{ target: 'a/wiki/b', summary: '' }]);
});

test('an answer is staged until its ledger says saved or gave up, and a filed one needs no staging copy', () => {
  const A = answerId(CHAT, 0);
  const B = answerId(CHAT, 1);
  const C = answerId(CHAT, 2);
  const D = '01JB8ZQ4M3T9X7K2W5R6N8P008' as AnswerId;
  const ledger = parseLedger([
    '# log',
    `## [2026-10-29] file-answer | ${B} | 실패 1/3 | broken-link 스터디/wiki/answers/x.md: [[없음]] does not resolve`,
    `## [2026-10-29] file-answer | ${C} | 저장 | answers/2026-10-29 질문.md`,
    `## [2026-10-29] file-answer | ${D} | gave up 3/3 | broken-link x: [[없음]] does not resolve`,
    `## [2026-10-29] ingest | 01JB8ZQ4M3T9X7K2W5R6N8P001 | 새 페이지 | RAG.md`,
  ].join('\n'));
  assert.deepEqual(ledger.ids('file-answer'), [B, C, D]);
  const staged = answerIdsIn([`${A}.md`, `${B}.md`, `${C}.md`, 'x.md', `${A}.md.txt`]);
  assert.deepEqual([...answerPlacements([{ domain: 스터디, staged, ledger }])], [
    [A, { state: 'staged', domain: 스터디 }],
    [B, { state: 'staged', domain: 스터디 }],
    [C, { state: 'saved', domain: 스터디, page: 'answers/2026-10-29 질문' }],
    [D, { state: 'gave-up', domain: 스터디, failure: { attempts: 3, max: 3, code: 'broken-link', detail: 'x: [[없음]] does not resolve' } }],
  ]);
  assert.deepEqual([...answerPlacements([{ domain: 일상, staged: new Set(), ledger: parseLedger('') }])], []);
});
