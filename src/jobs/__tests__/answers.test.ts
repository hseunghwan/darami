/**
 * Save answer from a stored turn to a page and a ledger line, through the same file-answer job,
 * journal, and check() as ingest (Done when 4's second half).
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { answerId, parseChatId } from '../../core/chat';
import { renderAnswerPage, renderAnswerStaging, type AnswerFiling } from '../../core/pages';
import { textFor } from '../../core/text';
import type { ChatTarget, DomainName } from '../../core/types';
import { nodeFs } from '../../fs/node';
import { memo, page, validFields } from '../../core/__tests__/helpers';
import { fakeModel, plays, turn, type Reply } from '../../agent/__tests__/fake-model';
import type { ModelRequest } from '../../agent/model';
import { changed, engineOn, memoryBook, memoryChats, memoryJournal, NO_SIGNAL, presetWiki, read, run, snapshot } from './harness';

const 스터디 = '스터디' as DomainName;
const 일상 = '일상' as DomainName;
const 스터디_CHAT: ChatTarget = { kind: 'domain', domain: 스터디 };
const ROOT_CHAT: ChatTarget = { kind: 'root' };
const CHAT = parseChatId('5d2c7a9e-1f3b-4c8d-9e0a-1b2c3d4e5f60')!;
const ASKED_AT = '2026-10-29T00:00:00.000Z';

const put = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};

async function wiki(chat: (req: ModelRequest, n: number) => Reply, ingest?: (req: ModelRequest, n: number) => Reply) {
  const root = await presetWiki('ko');
  put(root, '스터디/wiki/RAG.md', page(validFields('a', { summary: '청크 크기와 검색' }), '청크는 512 토큰.\n'));
  put(root, '일상/wiki/ME.md', page(validFields('c', { type: 'me', summary: '나' }), '나.\n'));
  const w = { chat, ingest };
  const chats = memoryChats();
  const model = fakeModel({ chat: (req, n) => w.chat(req, n), ingest: (req, n) => w.ingest!(req, n) });
  const engine = await engineOn(nodeFs(root), memoryJournal(), model, [], memoryBook(), chats);
  const ask = (text: string, target: ChatTarget = 스터디_CHAT) => engine.chats.ask({ chat: CHAT, target, text }, () => {}, NO_SIGNAL);
  return { root, engine, chats, w, ask };
}

const filing = (over: Partial<AnswerFiling> = {}): AnswerFiling => ({
  id: answerId(CHAT, 0), domain: 스터디, question: 'RAG 청크는 몇 토큰이지?', answer: '512 토큰이다. [[RAG]]', cited: [{ domain: 스터디, page: 'RAG' }], sessionId: CHAT, askedAt: ASKED_AT, ...over,
});

test('a saved answer is staged, shows staged in the book, and the job files it as a page, an index entry, and a ledger line', async () => {
  const w = await wiki(plays(turn.say('512 토큰이다. [[RAG]]')));
  await w.ask('RAG 청크는 몇 토큰이지?');
  const before = snapshot(w.root);
  const id = answerId(CHAT, 0);
  assert.deepEqual(await w.engine.saveAnswer({ chat: CHAT, n: 0 }), { kind: 'staged', domain: 스터디, id });
  assert.equal(read(w.root, `inbox/answers/스터디/${id}.md`), renderAnswerStaging(filing()));
  assert.deepEqual(w.engine.book.current().answers.get(id), { state: 'staged', domain: 스터디 });
  const existing = new Set(readdirSync(join(w.root, '스터디', 'wiki'), { recursive: true, encoding: 'utf8' }).filter((p) => p.endsWith('.md')));
  assert.deepEqual(await run(w.engine, '스터디', false), { kind: 'committed', job: { kind: 'file-answer', domain: 스터디, id }, verdict: 'saved' });
  const path = 'answers/2026-10-29 RAG 청크는 몇 토큰이지.md';
  assert.equal(read(w.root, `스터디/wiki/${path}`), renderAnswerPage(filing(), '2026-10-29', existing, textFor('ko')).content);
  assert.match(read(w.root, '스터디/wiki/index.md'), /\n## 저장된 답\n\n- \[\[스터디\/wiki\/answers\/2026-10-29 RAG 청크는 몇 토큰이지\|answers\/2026-10-29 RAG 청크는 몇 토큰이지\]\] - RAG 청크는 몇 토큰이지\?\n/);
  assert.ok(read(w.root, '스터디/wiki/log.md').endsWith(`## [2026-10-29] file-answer | ${id} | 저장 | ${path}\n`));
  assert.equal(existsSync(join(w.root, 'inbox', 'answers', '스터디', `${id}.md`)), false, 'the staging file is gone');
  assert.deepEqual(w.engine.book.current().answers.get(id), { state: 'saved', domain: 스터디, page: path.slice(0, -3) });
  assert.deepEqual(changed(before, snapshot(w.root)), [`스터디/wiki/${path}`, '스터디/wiki/index.md', '스터디/wiki/log.md']);
});

test('saving the same turn again is a duplicate, staged or filed, and writes nothing', async () => {
  const w = await wiki(plays(turn.say('512 토큰이다. [[RAG]]')));
  await w.ask('RAG 청크는 몇 토큰이지?');
  const id = answerId(CHAT, 0);
  await w.engine.saveAnswer({ chat: CHAT, n: 0 });
  const staged = snapshot(w.root);
  assert.deepEqual(await w.engine.saveAnswer({ chat: CHAT, n: 0 }), { kind: 'duplicate', domain: 스터디, id });
  assert.deepEqual(changed(staged, snapshot(w.root)), []);
  await run(w.engine, '스터디', false);
  const filed = snapshot(w.root);
  assert.deepEqual(await w.engine.saveAnswer({ chat: CHAT, n: 0 }), { kind: 'duplicate', domain: 스터디, id });
  assert.deepEqual(changed(filed, snapshot(w.root)), [], 'no staging file is made again');
  assert.deepEqual(await run(w.engine, '스터디', false), { kind: 'idle' });
});

test('a link the page would carry that names no page now refuses the save with its name, and nothing is staged', async () => {
  const w = await wiki(plays(turn.say('512 토큰이다. [[RAG]]')));
  await w.ask('RAG?');
  rmSync(join(w.root, '스터디', 'wiki', 'RAG.md'));
  const before = snapshot(w.root);
  assert.deepEqual(await w.engine.saveAnswer({ chat: CHAT, n: 0 }), { kind: 'refused', reason: { kind: 'missing-page', page: '스터디/wiki/RAG' } });
  assert.deepEqual(changed(before, snapshot(w.root)), []);

  const inline = await wiki(plays(turn.say('[[일상/wiki/ME]]에 적었다. 그리고 [[없는 페이지]].')));
  await inline.ask('나는?');
  assert.deepEqual(await inline.engine.saveAnswer({ chat: CHAT, n: 0 }), { kind: 'refused', reason: { kind: 'missing-page', page: '없는 페이지' } }, 'an inline link that is not a citation is checked too');
});

test('a page an uncommitted ingest made does not count at save time', async () => {
  let reach = () => {};
  const reached = new Promise<void>((r) => (reach = r));
  let open = () => {};
  const opened = new Promise<void>((r) => (open = r));
  const w = await wiki(
    () => turn.say('-'),
    plays(turn.write('wiki/새것.md', page(validFields('n'), '새 페이지.\n')), () => (reach(), opened.then(() => turn.finish('created')))),
  );
  await w.engine.accept(memo(1, '새것', { domain_hint: '스터디' }));
  await w.engine.routeNext(NO_SIGNAL);
  const ingest = run(w.engine, '스터디');
  await reached;
  await w.chats.add({ chat: CHAT, n: 0, target: '스터디', askedAt: ASKED_AT, at: ASKED_AT, question: '새것?', outcome: { kind: 'answered', answer: '[[새것]]', cited: ['스터디/wiki/새것'] } });
  assert.deepEqual(await w.engine.saveAnswer({ chat: CHAT, n: 0 }), { kind: 'refused', reason: { kind: 'missing-page', page: '스터디/wiki/새것' } });
  open();
  assert.equal((await ingest).kind, 'committed');
  assert.equal((await w.engine.saveAnswer({ chat: CHAT, n: 0 })).kind, 'staged', 'once committed it counts');
});

test('a root answer is filed into the domain of its first citation, and one that cites nothing cannot be saved', async () => {
  const w = await wiki(plays(turn.say('[[일상/wiki/ME]] 그리고 [[스터디/wiki/RAG]]')));
  await w.ask('나와 RAG?', ROOT_CHAT);
  const id = answerId(CHAT, 0);
  assert.deepEqual(await w.engine.saveAnswer({ chat: CHAT, n: 0 }), { kind: 'staged', domain: 일상, id });
  assert.deepEqual(await run(w.engine, '일상', false), { kind: 'committed', job: { kind: 'file-answer', domain: 일상, id }, verdict: 'saved' });
  w.w.chat = plays(turn.say('위키에 없다.'));
  await w.ask('없는 것?', ROOT_CHAT);
  assert.deepEqual(await w.engine.saveAnswer({ chat: CHAT, n: 1 }), { kind: 'refused', reason: { kind: 'no-domain' } });
});

test('save refuses a failed turn, an unknown turn, a domain no longer declared, and a broken config', async () => {
  const w = await wiki(plays(turn.unavailable('server')));
  await w.ask('q');
  assert.deepEqual(await w.engine.saveAnswer({ chat: CHAT, n: 0 }), { kind: 'refused', reason: { kind: 'no-turn' } });
  assert.deepEqual(await w.engine.saveAnswer({ chat: CHAT, n: 7 }), { kind: 'refused', reason: { kind: 'no-turn' } });
  const gone = parseChatId('9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d')!;
  await w.chats.add({ chat: gone, n: 0, target: '없음', askedAt: ASKED_AT, at: ASKED_AT, question: 'q', outcome: { kind: 'answered', answer: 'a', cited: [] } });
  assert.deepEqual(await w.engine.saveAnswer({ chat: gone, n: 0 }), { kind: 'refused', reason: { kind: 'no-domain' } });
  w.w.chat = plays(turn.say('[[RAG]]'));
  await w.ask('q2');
  writeFileSync(join(w.root, 'dotoriwiki.yaml'), 'version: 2\n');
  const r = await w.engine.saveAnswer({ chat: CHAT, n: 1 });
  assert.equal(r.kind === 'refused' && r.reason.kind, 'paused');
});
