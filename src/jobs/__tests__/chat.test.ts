/**
 * Chat through the engine, on the ko preset with pages the engine indexed when it opened, and
 * memoryChats(). The model is scripted; the folder is the node adapter.
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { answerId, parseChatId, rememberId } from '../../core/chat';
import type { ChatTarget, DomainName } from '../../core/types';
import { nodeFs } from '../../fs/node';
import { memo, page, validFields } from '../../core/__tests__/helpers';
import { fakeModel, plays, turn, type Reply } from '../../agent/__tests__/fake-model';
import type { ModelRequest, ModelTurn } from '../../agent/model';
import type { ChatProgress } from '../engine';
import { changed, countingFs, engineOn, memoryBook, memoryChats, memoryJournal, NO_SIGNAL, presetWiki, read, run, snapshot } from './harness';

const 스터디 = '스터디' as DomainName;
const 일상 = '일상' as DomainName;
const 스터디_CHAT: ChatTarget = { kind: 'domain', domain: 스터디 };
const ROOT_CHAT: ChatTarget = { kind: 'root' };
const CHAT = parseChatId('5d2c7a9e-1f3b-4c8d-9e0a-1b2c3d4e5f60')!;
const OTHER = parseChatId('9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d')!;
const RAG = page(validFields('a', { summary: '청크 크기와 검색' }), '청크는 512 토큰.\n');

const put = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

/** Several tool calls in one turn. */
const many = (...turns: ModelTurn[]): ModelTurn => ({ ok: true, output: turns.flatMap((t) => (t.ok ? t.output : [])), text: '' });
const outputs = (req: ModelRequest) => req.input.filter((i) => i.type === 'function_call_output').map((i) => (i as { output: string }).output);

/** A gate a scripted turn waits on, and a promise that the turn reached it. */
function gate() {
  let open = () => {};
  let reach = () => {};
  const opened = new Promise<void>((r) => (open = r));
  const reached = new Promise<void>((r) => (reach = r));
  return { open, reached, wait: <T,>(then: () => T) => (reach(), opened.then(then)) };
}

/** The ko preset with 스터디's RAG and 개념/청크 and 일상's ME, opened so the engine writes their index.md. `chat` can be swapped between questions. */
async function wiki(chat: (req: ModelRequest, n: number) => Reply = () => turn.say('-'), ingest?: (req: ModelRequest, n: number) => Reply) {
  const root = await presetWiki('ko');
  put(root, '스터디/wiki/RAG.md', RAG);
  put(root, '스터디/wiki/개념/청크.md', page(validFields('b', { summary: '청크' }), '청크.\n'));
  put(root, '일상/wiki/ME.md', page(validFields('c', { type: 'me', summary: '나' }), '나.\n'));
  const w = { chat, ingest };
  const model = fakeModel({ chat: (req, n) => w.chat(req, n), ingest: (req, n) => w.ingest!(req, n) });
  const fs = countingFs(nodeFs(root));
  const engine = await engineOn(fs, memoryJournal(), model, [], memoryBook(), memoryChats());
  const ask = (text: string, target: ChatTarget = 스터디_CHAT, chat = CHAT, progress: ChatProgress[] = [], signal = NO_SIGNAL) =>
    engine.chats.ask({ chat, target, text }, (p) => progress.push(p), signal);
  return { root, fs, model, engine, w, ask };
}

test('an answer streams after a preamble the screen drops, and only the final message is kept', async () => {
  const w = await wiki(plays(turn.stream(['Let me ', 'look.'], turn.read('스터디/wiki/index.md')), turn.stream(['RAG는 ', '[[스터디/wiki/RAG]]에 있다.'])));
  const progress: ChatProgress[] = [];
  const r = await w.ask('  RAG는?  ', 스터디_CHAT, CHAT, progress);
  assert.ok(r.kind === 'answered');
  assert.deepEqual(progress, [
    { kind: 'text', text: 'Let me ' },
    { kind: 'text', text: 'Let me look.' },
    { kind: 'reading', paths: ['스터디/wiki/index.md'] },
    { kind: 'text', text: 'RAG는 ' },
    { kind: 'text', text: 'RAG는 [[스터디/wiki/RAG]]에 있다.' },
  ]);
  assert.equal(r.turn.question, 'RAG는?');
  assert.equal(r.turn.answer, 'RAG는 [[스터디/wiki/RAG]]에 있다.');
  assert.deepEqual(r.turn.cited, [{ domain: 스터디, page: 'RAG' }]);
  assert.equal(r.turn.saveTo, 스터디);
  assert.equal(r.turn.answerId, answerId(CHAT, 0));
  assert.equal(r.turn.memo, rememberId(CHAT, 0));
  assert.deepEqual(r.trace, { turns: 2, tools: ['read'], wrapped: false });
  assert.deepEqual(await w.engine.chats.open(CHAT), { id: CHAT, target: 스터디_CHAT, turns: [r.turn] });
  assert.match(outputs(w.model.requests[1]!)[0]!, /\[\[스터디\/wiki\/RAG\|RAG\]\] - 청크 크기와 검색/, 'index.md is the engine\'s');
});

test('a domain chat is told its CLAUDE.md, its page types, and the chat rules; a root chat the root CLAUDE.md and the domains', async () => {
  const w = await wiki(plays(turn.say('a')));
  await w.ask('q');
  const domain = w.model.requests[0]!.instructions;
  assert.ok(domain.startsWith(read(w.root, '스터디/CLAUDE.md').split('\n')[0]!));
  for (const part of ['## 페이지 종류', '## 채팅 규칙', '`스터디/wiki/index.md`를 먼저 읽고', '## 작업 환경', '경로는 위키 폴더 기준이다']) assert.ok(domain.includes(part), part);
  w.w.chat = plays(turn.say('b'));
  await w.ask('q', ROOT_CHAT, OTHER);
  const root = w.model.requests[1]!.instructions;
  assert.ok(root.startsWith(read(w.root, 'CLAUDE.md')), 'the root CLAUDE.md as written');
  for (const part of ['## 도메인 목록', '| `스터디` |', '각 도메인의 `<도메인>/wiki/index.md`를']) assert.ok(root.includes(part), part);
  assert.ok(!root.includes(read(w.root, '일상/CLAUDE.md').split('\n')[0]!), 'no domain CLAUDE.md');
});

test('a domain chat cites pages that exist: bare and explicit, other domains, first seen, deduped, code skipped, basenames as written', async () => {
  const w = await wiki(plays(turn.say('[[RAG]] [[스터디/wiki/RAG]] [[일상/wiki/ME]] [[없음]] `[[개념/청크]]` [[청크|조각]] [[RAG|라벨]]')));
  const r = await w.ask('q');
  assert.ok(r.kind === 'answered');
  assert.deepEqual(r.turn.cited, [{ domain: 스터디, page: 'RAG' }, { domain: 일상, page: 'ME' }, { domain: 스터디, page: '청크' }]);
  assert.deepEqual([...r.turn.links.keys()], ['RAG', '스터디/wiki/RAG', '일상/wiki/ME', '청크']);
});

test('a root chat cites only domain/wiki/page links and saves to the first cited domain; one citing nothing has nowhere to save', async () => {
  const w = await wiki(plays(turn.say('[[RAG]] [[일상/wiki/ME]] [[nowhere/wiki/x]] [[스터디/wiki/RAG]]')));
  const r = await w.ask('q', ROOT_CHAT);
  assert.ok(r.kind === 'answered');
  assert.deepEqual(r.turn.cited, [{ domain: 일상, page: 'ME' }, { domain: 스터디, page: 'RAG' }]);
  assert.equal(r.turn.saveTo, 일상);
  w.w.chat = plays(turn.say('위키에 없다.'));
  const none = await w.ask('q2', ROOT_CHAT);
  assert.ok(none.kind === 'answered');
  assert.equal(none.turn.saveTo, null);
});

test('a chat changes no file, whatever its model asks for', async () => {
  const escapes = many(
    ...['스터디/raw/x.md', '스터디/hold/x.md', 'inbox/x.md', 'inbox/answers/스터디/x.md', '_attachments/a.jpg', '.obsidian/app.json', '../x', '/etc/hosts', '일상/CLAUDE.md'].map(turn.read),
    turn.list(''), turn.list('스터디'), turn.list('스터디/raw'), turn.list('..'), turn.search('RAG'),
    turn.write('스터디/wiki/x.md', 'x'), turn.edit('스터디/wiki/RAG.md', '512', '1024'), turn.finish('created'), turn.call('rm', { path: '스터디/wiki/RAG.md' }),
  );
  const w = await wiki(plays(escapes, turn.say('[[RAG]]')));
  const before = snapshot(w.root);
  w.fs.reset();
  const r = await w.ask('다 해봐');
  assert.equal(r.kind, 'answered');
  assert.deepEqual(changed(before, snapshot(w.root)), []);
  assert.equal(w.fs.calls('write') + w.fs.calls('create') + w.fs.calls('remove'), 0);
  assert.equal(w.fs.calls('listTree'), 0, 'list of a folder above the chat roots and search walk nothing');
  const answers = outputs(w.model.requests[1]!);
  for (const a of answers.slice(0, 9)) assert.match(a, /^error: no such file: /, a);
  assert.deepEqual(answers.slice(-4), ['error: no tool named write', 'error: no tool named edit', 'error: no tool named finish', 'error: no tool named rm']);
  assert.equal(w.fs.calls('readText', (p) => /\/(raw|hold)\/|^inbox|^_attachments|^\.obsidian/.test(p)), 0);
});

test('a chat reads the wiki as of the last commit while an ingest rewrites it, then sees the commit', async () => {
  const g = gate();
  const rag2 = page(validFields('a', { summary: '청크 크기와 검색' }), '청크는 1024 토큰.\n');
  const w = await wiki(
    plays(many(turn.read('스터디/wiki/RAG.md'), turn.read('스터디/wiki/새것.md'), turn.list('스터디/wiki')), turn.say('[[새것]] [[RAG]]')),
    plays(turn.read('wiki/RAG.md'), turn.write('wiki/RAG.md', rag2), turn.write('wiki/새것.md', page(validFields('n'), '새 페이지.\n')), () => g.wait(() => turn.finish('updated'))),
  );
  await w.engine.accept(memo(1, 'RAG 갱신', { domain_hint: '스터디' }));
  await w.engine.routeNext(NO_SIGNAL);
  const ingest = run(w.engine, '스터디');
  await g.reached;
  assert.equal(read(w.root, '스터디/wiki/RAG.md'), rag2, 'the folder holds the uncommitted text');
  const during = await w.ask('RAG?');
  const [rag, made, listed] = outputs(w.model.requests.at(-1)!);
  assert.equal(rag, RAG);
  assert.match(made!, /^error: no such file: 스터디\/wiki\/새것\.md/);
  assert.ok(!listed!.includes('새것'), listed);
  assert.ok(during.kind === 'answered');
  assert.deepEqual(during.turn.cited, [{ domain: 스터디, page: 'RAG' }]);
  g.open();
  assert.equal((await ingest).kind, 'committed');
  w.w.chat = plays(turn.read('스터디/wiki/새것.md'), turn.say('[[새것]]'));
  const after = await w.ask('새것?', 스터디_CHAT, OTHER);
  assert.match(outputs(w.model.requests.at(-1)!)[0]!, /새 페이지\./);
  assert.ok(after.kind === 'answered');
  assert.deepEqual(after.turn.cited, [{ domain: 스터디, page: '새것' }]);
});

test('failed turns are kept with their reason and number, aborted ones never are, and history skips failures', async () => {
  const w = await wiki(plays(turn.unavailable('rate-limited', 300_000)));
  const limited = await w.ask('첫 질문');
  assert.deepEqual(limited, {
    kind: 'failed',
    turn: { kind: 'failed', n: 0, askedAt: '2026-10-29T00:00:00.000Z', question: '첫 질문', failure: 'rate-limited', memo: rememberId(CHAT, 0) },
    retryAt: Date.parse('2026-10-29T00:00:00.000Z') + 300_000,
    trace: null,
  });
  w.w.chat = plays(turn.cancelled());
  assert.deepEqual(await w.ask('취소'), { kind: 'cancelled' });
  w.w.chat = plays(turn.say('답'));
  const answered = await w.ask('둘째 질문');
  assert.ok(answered.kind === 'answered');
  assert.equal(answered.turn.n, 1);
  assert.equal(answered.turn.answerId, answerId(CHAT, 1));
  assert.deepEqual(w.model.requests.at(-1)!.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '둘째 질문' }] }]);
  w.w.chat = plays(turn.say('셋'));
  await w.ask('셋째');
  assert.deepEqual(w.model.requests.at(-1)!.input.map((i) => (i as { role: string }).role), ['user', 'assistant', 'user']);
  assert.deepEqual((await w.engine.chats.open(CHAT))!.turns.map((t) => [t.n, t.kind]), [[0, 'failed'], [1, 'answered'], [2, 'answered']]);
});

test('one question at a time per chat, one target per chat, and nothing asked for a blank question or an undeclared domain', async () => {
  const g = gate();
  const w = await wiki(plays(() => g.wait(() => turn.say('느린 답'))));
  const first = w.ask('q');
  await g.reached;
  assert.deepEqual(await w.ask('again'), { kind: 'busy' });
  g.open();
  assert.equal((await first).kind, 'answered');
  assert.deepEqual(await w.ask('root?', ROOT_CHAT), { kind: 'other-target' });
  assert.deepEqual(await w.ask('   '), { kind: 'blank' });
  assert.deepEqual(await w.ask('q', { kind: 'domain', domain: '없음' as DomainName }, OTHER), { kind: 'no-domain' });
  assert.equal(w.model.requests.length, 1);
});

test('past chats are listed with their titles, and deleting one stops its question and leaves the wiki alone', async () => {
  const w = await wiki(plays(turn.say('a')));
  const long = `${'가'.repeat(40)}끝`;
  await w.ask(long);
  w.w.chat = plays(turn.say('b'));
  await w.ask('짧은 질문', ROOT_CHAT, OTHER);
  assert.deepEqual((await w.engine.chats.list()).map((c) => [c.id, c.target, c.title, c.turns]), [
    [OTHER, ROOT_CHAT, '짧은 질문', 1],
    [CHAT, 스터디_CHAT, `${'가'.repeat(39)}…`, 1],
  ]);
  const before = snapshot(w.root);
  const g = gate();
  w.w.chat = plays(() => g.wait(() => turn.say('늦은 답')));
  const asking = w.ask('지울 때 도는 질문');
  await g.reached;
  const removing = w.engine.chats.remove(CHAT);
  g.open();
  assert.deepEqual(await asking, { kind: 'cancelled' });
  await removing;
  assert.equal(await w.engine.chats.open(CHAT), null);
  assert.deepEqual((await w.engine.chats.list()).map((c) => c.id), [OTHER]);
  assert.deepEqual(changed(before, snapshot(w.root)), []);
});

test('the page viewer reads a committed page by path or basename, and nothing outside a declared wiki', async () => {
  const w = await wiki();
  put(w.root, '스터디/raw/x.md', 'raw');
  const rag = await w.engine.page({ domain: 스터디, page: 'RAG' });
  assert.deepEqual(rag && { ...rag, links: [...rag.links] }, {
    ref: { domain: 스터디, page: 'RAG' }, path: 'RAG', type: 'concept', summary: '청크 크기와 검색', updated: '2026-10-29', body: '청크는 512 토큰.\n', links: [],
  });
  assert.equal((await w.engine.page({ domain: 스터디, page: '청크' }))?.path, '개념/청크');
  assert.equal((await w.engine.page({ domain: 스터디, page: '개념/청크' }))?.path, '개념/청크');
  for (const ref of [{ domain: 스터디, page: '없음' }, { domain: 스터디, page: '../raw/x' }, { domain: '없음' as DomainName, page: 'RAG' }, { domain: 스터디, page: '개념/없음' }]) {
    assert.equal(await w.engine.page(ref), null, ref.page);
  }
});
