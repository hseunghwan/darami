import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderAnswerStaging, renderMemoFile, type AnswerFiling } from '../../core/pages';
import type { AnswerId, DomainName, MemoId } from '../../core/types';
import { nodeFs } from '../../fs/node';
import { memo, page, ulid, validFields } from '../../core/__tests__/helpers';
import { fakeModel, plays, turn, type Script } from '../../agent/__tests__/fake-model';
import type { EngineEvent } from '../engine';
import { changed, engineOn, everyKill, Killed, memoryJournal, presetWiki, read, run, NO_SIGNAL, snapshot, template, type Store } from './harness';

const 스터디 = '스터디' as DomainName;
const LOG = '스터디/wiki/log.md';
const line = (id: string, third: string, fourth: string) => `## [2026-10-29] ingest | ${id} | ${third} | ${fourth}\n`;
const rag = (id: string) => page(validFields(id, { summary: '청크 크기와 검색' }), '청크는 512 토큰.\n');

async function wiki(script: Script, store: Store = memoryJournal()) {
  const root = await presetWiki('ko');
  const model = fakeModel(script);
  const events: EngineEvent[] = [];
  const engine = await engineOn(nodeFs(root), store, model, events);
  return { root, store, model, events, engine, reopen: () => engineOn(nodeFs(root), store, model, events) };
}

test('a typed memo with a hint is routed with no model call and filed into its domain with one ledger line', async () => {
  const id = ulid(1);
  const w = await wiki({ ingest: plays(turn.read(`raw/${id}.md`), turn.write('wiki/RAG.md', rag(id)), turn.finish('created')) });
  assert.deepEqual(await w.engine.accept(memo(1, 'RAG 청크 512', { domain_hint: ' 스터디 ' })), { kind: 'created' });
  assert.deepEqual(await w.engine.routeNext(NO_SIGNAL), { kind: 'routed', id, domain: 스터디, routing: { by: 'hint' } });
  assert.equal(w.model.requests.length, 0, 'a hint needs no classifier');
  assert.deepEqual(await w.engine.routeNext(NO_SIGNAL), { kind: 'idle' });
  assert.deepEqual(await run(w.engine, '스터디'), { kind: 'committed', job: { kind: 'ingest', domain: 스터디, id }, verdict: 'created' });
  assert.equal(read(w.root, LOG), `# log\n${line(id, '새 페이지', 'RAG.md')}`);
  assert.equal(read(w.root, '스터디/wiki/RAG.md'), rag(id));
  assert.match(read(w.root, '스터디/wiki/index.md'), /\n- \[\[스터디\/wiki\/RAG\|RAG\]\] - 청크 크기와 검색\n/);
  assert.equal(read(w.root, `스터디/raw/${id}.md`), renderMemoFile({ ...memo(1, 'RAG 청크 512', { domain_hint: '스터디' }), attachments: [] }, { by: 'hint' }));
  assert.deepEqual(await w.engine.locate(id as MemoId), { domain: 스터디, state: 'ingested' });
  assert.deepEqual(await run(w.engine, '스터디'), { kind: 'idle' });
  assert.deepEqual(w.events.filter((e) => e.kind === 'started'), [{ kind: 'started', job: { kind: 'ingest', domain: 스터디, id }, attempt: 1 }]);
  assert.equal(w.store.rows(), 0);
});

test('the ingest model is told the domain, its page types, the rules, the tools, and the memo to file', async () => {
  const id = ulid(1);
  const w = await wiki({ ingest: plays(turn.finish('unchanged')) });
  await w.engine.accept(memo(1, '메모', { domain_hint: '스터디' }));
  await w.engine.routeNext(NO_SIGNAL);
  await run(w.engine, '스터디');
  const req = w.model.requests[0]!;
  assert.equal(req.role, 'ingest');
  assert.ok(req.instructions.startsWith(read(w.root, '스터디/CLAUDE.md').split('\n')[0]!), 'the domain CLAUDE.md first');
  for (const part of ['## 페이지 종류', '오늘 날짜는 2026-10-29다', '`finish` 도구로', '## 작업 환경', '도메인 폴더 `스터디/`']) assert.ok(req.instructions.includes(part), part);
  assert.deepEqual(req.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: `원본 \`raw/${id}.md\` 하나를 정리 작업 순서대로 위키에 반영해라.` }] }]);
  assert.equal(read(w.root, LOG), `# log\n${line(id, '정리할 거리 없음', '-')}`);
});

test('the classifier routes at 0.6 and above, holds below it in the domain it named, and holds in fallback_domain after two failed tries', async () => {
  const cases: [Script['classify'], string, string, object][] = [
    [() => turn.route('스터디', 0.6, '공부'), 'routed', '스터디/raw', { by: 'classifier', confidence: 0.6, reason: '공부' }],
    [() => turn.route('스터디', 0.59, '애매함'), 'held', '스터디/hold', { by: 'classifier', confidence: 0.59, reason: '애매함' }],
    [() => turn.route('개발', 0.9, '?'), 'held', '일상/hold', { by: 'fallback', reason: 'classifier named unknown domain 개발' }],
    [(_r, n) => (n === 1 ? turn.say('잘 모르겠다') : turn.route('미루기 아카이빙', 0.8, '나중에')), 'routed', '미루기 아카이빙/raw', { by: 'classifier', confidence: 0.8, reason: '나중에' }],
  ];
  for (const [classify, kind, dir, routing] of cases) {
    const w = await wiki({ classify });
    await w.engine.accept(memo(1, '메모', { domain_hint: '없는 도메인' }));
    const r = await w.engine.routeNext(NO_SIGNAL);
    assert.equal(r.kind, kind, JSON.stringify(routing));
    assert.deepEqual('routing' in r && r.routing, routing);
    assert.equal(read(w.root, `${dir}/${ulid(1)}.md`), renderMemoFile({ ...memo(1, '메모', { domain_hint: '없는 도메인' }), attachments: [] }, routing as never));
    assert.ok(w.model.requests.length <= 2);
  }
});

test('the classifier reads the root CLAUDE.md and the domain catalog, and the memo with its project line', async () => {
  const w = await wiki({ classify: () => turn.route('스터디', 0.9, 'r') });
  await w.engine.accept(memo(4, '노트 앱에서 RAG 실험 중', { source: 'agent', context: { project: 'notes-app', cwd: '/w', branch: 'main' } }));
  await w.engine.routeNext(NO_SIGNAL);
  const req = w.model.requests[0]!;
  assert.equal(req.instructions, `${read(w.root, 'CLAUDE.md')}\n\n## 도메인 목록\n\n| 폴더 | 한 줄 정의 |\n| --- | --- |\n${req.instructions.split('| --- | --- |\n')[1]}`);
  assert.deepEqual(req.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '노트 앱에서 RAG 실험 중\n\n작성 맥락: 프로젝트 notes-app, 브랜치 main' }] }]);
});

test('an unavailable classifier leaves the inbox as it was and spends nothing', async () => {
  const w = await wiki({ classify: () => turn.unavailable('rate-limited', 90_000) });
  await w.engine.accept(memo(1));
  const before = snapshot(w.root);
  assert.deepEqual(await w.engine.routeNext(NO_SIGNAL), { kind: 'unavailable', unavailable: { kind: 'unavailable', cause: 'rate-limited', detail: 'rate-limited', retryAfterMs: 90_000 } });
  assert.deepEqual(changed(before, snapshot(w.root)), []);
  assert.equal(w.model.requests.length, 1, 'no second try on unavailable');
});

test('accept writes the inbox once, a resend changes nothing, and a memo with photos waits for P6', async () => {
  const w = await wiki({});
  assert.deepEqual(await w.engine.accept(memo(1, 'x', { domain_hint: '일상' })), { kind: 'created' });
  assert.deepEqual(await w.engine.accept(memo(1, 'x', { domain_hint: '일상' })), { kind: 'duplicate', at: 'inbox' });
  await w.engine.routeNext(NO_SIGNAL);
  await w.engine.accept(memo(2, 'x', { domain_hint: '스터디' }));
  await w.engine.routeNext(NO_SIGNAL);
  assert.equal((await w.engine.routeNext(NO_SIGNAL)).kind, 'idle');
  const before = snapshot(w.root);
  assert.deepEqual(await w.engine.accept(memo(2, 'x', { domain_hint: '스터디' })), { kind: 'duplicate', at: { domain: 스터디, state: 'routed' } });
  assert.deepEqual(await w.engine.accept(memo(3, 'x', { attachments: [{ n: 1, origin: 'camera' }] })), { kind: 'photos-unsupported' });
  assert.deepEqual(changed(before, snapshot(w.root)), []);
});

test('the router rejects a file it cannot read as a memo, drops a copy already routed, and routes again past a copy cut off', async () => {
  const w = await wiki({});
  writeFileSync(join(w.root, 'inbox', 'notes.md'), 'no frontmatter\n');
  assert.deepEqual(await w.engine.routeNext(NO_SIGNAL), { kind: 'rejected', file: 'notes.md', reason: 'no frontmatter' });
  assert.equal(read(w.root, 'inbox/.rejected/notes.md'), 'no frontmatter\n');

  const id = ulid(1);
  const text = renderMemoFile({ ...memo(1, 'x', { domain_hint: '스터디' }), attachments: [] }, null);
  writeFileSync(join(w.root, 'inbox', `${id}.md`), text);
  writeFileSync(join(w.root, '스터디', 'raw', `${id}.md`), renderMemoFile({ ...memo(1, 'x', { domain_hint: '스터디' }), attachments: [] }, { by: 'hint' }));
  assert.deepEqual(await w.engine.routeNext(NO_SIGNAL), { kind: 'dropped-duplicate', id });

  writeFileSync(join(w.root, 'inbox', `${id}.md`), text);
  writeFileSync(join(w.root, '스터디', 'raw', `${id}.md`), text.slice(0, 20));
  writeFileSync(join(w.root, 'inbox', `${ulid(2)}.md`), '');
  assert.deepEqual(await w.engine.routeNext(NO_SIGNAL), { kind: 'routed', id, domain: 스터디, routing: { by: 'hint' } });
  assert.equal(read(w.root, `스터디/raw/${id}.md`), renderMemoFile({ ...memo(1, 'x', { domain_hint: '스터디' }), attachments: [] }, { by: 'hint' }));
  assert.equal(read(w.root, `inbox/${ulid(2)}.md`), '', 'an empty inbox file is an accept cut off; it waits');
});

async function routedMemo(script: Script, n = 1) {
  const w = await wiki(script);
  await w.engine.accept(memo(n, '메모', { domain_hint: '스터디' }));
  await w.engine.routeNext(NO_SIGNAL);
  return w;
}

test('unavailable mid-job rolls back what the model wrote, writes no line, and spends no attempt', async () => {
  const id = ulid(1);
  let unavailable = true;
  const w = await routedMemo({ ingest: (_r, n) => (n === 1 ? turn.write('wiki/RAG.md', rag(id)) : unavailable ? turn.unavailable('rate-limited') : turn.finish('created')) });
  const before = snapshot(w.root);
  const r = await run(w.engine, '스터디');
  assert.equal(r.kind, 'unavailable');
  assert.deepEqual(changed(before, snapshot(w.root)), []);
  unavailable = false;
  assert.equal((await run(w.engine, '스터디')).kind, 'committed');
  assert.equal(read(w.root, LOG), `# log\n${line(id, '새 페이지', 'RAG.md')}`);
});

test('a cancelled job rolls back and writes no line', async () => {
  const w = await routedMemo({ ingest: (_r, n) => (n === 1 ? turn.write('wiki/RAG.md', rag(ulid(1))) : turn.cancelled()) });
  const before = snapshot(w.root);
  assert.equal((await run(w.engine, '스터디')).kind, 'cancelled');
  assert.deepEqual(changed(before, snapshot(w.root)), []);
});

test('three failed attempts give up with a _review.md note, each retry told why the last one failed', async () => {
  const id = ulid(1);
  const w = await routedMemo({ ingest: (_r, n) => (n === 1 ? turn.write('wiki/a.md', page(validFields(id), '[[없음]]\n')) : turn.finish('created')) });
  const reason = 'broken-link 스터디/wiki/a.md: [[없음]] does not resolve';
  assert.deepEqual((await run(w.engine, '스터디')), { kind: 'retrying', job: { kind: 'ingest', domain: 스터디, id }, attempt: 1, problems: [{ rule: 'broken-link', path: '스터디/wiki/a.md', detail: '[[없음]] does not resolve' }] });
  assert.equal((await run(w.engine, '스터디')).kind, 'retrying');
  assert.equal((await run(w.engine, '스터디')).kind, 'gave-up');
  assert.deepEqual(await run(w.engine, '스터디'), { kind: 'idle' });
  assert.equal(read(w.root, LOG), `# log\n${line(id, '실패 1/3', reason)}${line(id, '실패 2/3', reason)}${line(id, '포기 3/3', reason)}`);
  assert.equal(read(w.root, '스터디/wiki/_review.md'), `# 검토할 것\n\n- [2026-10-29] ingest \`${id}\` 포기 3/3: ${reason}\n`);
  const prompts = w.model.requests.filter((q) => q.input.length === 1).map((q) => (q.input[0] as unknown as { content: { text: string }[] }).content[0]!.text);
  assert.equal(prompts.length, 3);
  assert.ok(!prompts[0]!.includes('지난 시도'));
  assert.ok(prompts[1]!.includes(`이유: ${reason}`));
  assert.deepEqual(await w.engine.locate(id as MemoId), { domain: 스터디, state: 'failed' });
});

test('a model that fails the run, or never finishes, fails the attempt with rule llm', async () => {
  const id = ulid(1);
  const w = await routedMemo({ ingest: () => turn.say('할 말이 없다') });
  assert.deepEqual((await run(w.engine, '스터디')), { kind: 'retrying', job: { kind: 'ingest', domain: 스터디, id }, attempt: 1, problems: [{ rule: 'llm', path: '', detail: 'the model stopped without calling finish' }] });
  assert.equal(read(w.root, LOG), `# log\n## [2026-10-29] ingest | ${id} | 실패 1/3 | llm : the model stopped without calling finish\n`);
});

test('a page changed under a running job fails its attempt with input-modified when the memo changed, and the reread rule guards pages', async () => {
  const id = ulid(1);
  let root = '';
  const w = await routedMemo({
    ingest: plays(
      turn.write('wiki/RAG.md', rag(id)),
      () => (writeFileSync(join(root, '스터디', 'wiki', 'RAG.md'), 'Obsidian\n'), turn.write('wiki/RAG.md', rag(id))),
      turn.read('wiki/RAG.md'),
      () => (writeFileSync(join(root, '스터디', 'raw', `${id}.md`), 'changed\n'), turn.write('wiki/RAG.md', rag(id))),
      turn.finish('created'),
    ),
  });
  root = w.root;
  const r = await run(w.engine, '스터디');
  const answers = w.model.requests.at(-1)!.input.filter((i) => i.type === 'function_call_output').map((i) => (i as { output: string }).output);
  assert.deepEqual(answers, ['created wiki/RAG.md', 'error: wiki/RAG.md changed since you read it; read it again', 'Obsidian\n', 'wrote wiki/RAG.md']);
  assert.ok(r.kind === 'retrying');
  assert.deepEqual(r.problems, [{ rule: 'input-modified', path: `스터디/raw/${id}.md`, detail: 'raw input changed' }]);
});

test('three kills mid-job give interrupted 1/3, 2/3, then gave up 3/3 with its note', async () => {
  const id = ulid(1);
  const w = await routedMemo({ ingest: (_r, n) => (n === 1 ? turn.write('wiki/RAG.md', rag(id)) : Promise.reject(new Killed('model turn'))) });
  for (let i = 0; i < 3; i++) {
    const e = await engineOn(nodeFs(w.root), w.store, w.model, w.events);
    await assert.rejects(run(e, '스터디'), Killed);
  }
  await w.reopen();
  const why = 'app stopped mid-job';
  assert.equal(read(w.root, LOG), `# log\n${line(id, '중단 1/3', why)}${line(id, '중단 2/3', why)}${line(id, '포기 3/3', why)}`);
  assert.equal(read(w.root, '스터디/wiki/_review.md'), `# 검토할 것\n\n- [2026-10-29] ingest \`${id}\` 포기 3/3: ${why}\n`);
  assert.equal(read(w.root, '스터디/wiki/index.md').includes('RAG'), false, 'the page each kill left was rolled back');
  assert.deepEqual(w.events.filter((e) => e.kind === 'recovered').map((e) => e.kind === 'recovered' && e.as), ['interrupted', 'interrupted', 'gave-up']);
});

test('a kill anywhere in an ingest, and anywhere in the recovery after it, leaves it committed or interrupted, and the next run files it', async () => {
  const id = ulid(1);
  const script: Script = { ingest: plays(turn.read(`raw/${id}.md`), turn.write('wiki/RAG.md', rag(id)), turn.write('wiki/인사이트/2026.md', page(validFields(id, { type: 'insight' }), '- [[RAG]]\n')), turn.finish('created')) };
  const prep = async () => {
    const w = await routedMemo(script);
    return { root: w.root, store: w.store };
  };
  const fresh = await template(prep);
  const before = snapshot((await fresh()).root);
  const ends = new Set<string>();
  const seen = await everyKill({
    fresh,
    act: async (fs, store) => void (await (await engineOn(fs, store, fakeModel(script))).runNext(스터디, { withModel: true, signal: NO_SIGNAL })),
    reopen: async (fs, store) => void (await engineOn(fs, store, fakeModel(script))),
    check: async (root, store, where) => {
      const log = read(root, LOG);
      const end = log === '# log\n' ? 'untouched' : log === `# log\n${line(id, '새 페이지', 'RAG.md, 인사이트/2026.md')}` ? 'committed' : log === `# log\n${line(id, '중단 1/3', 'app stopped mid-job')}` ? 'interrupted' : null;
      assert.ok(end, `${where}: ${log}`);
      ends.add(end);
      if (end !== 'committed') {
        assert.deepEqual(changed(before, snapshot(root)), end === 'untouched' ? [] : [LOG], where);
        assert.equal((await (await engineOn(nodeFs(root), store, fakeModel(script))).runNext(스터디, { withModel: true, signal: NO_SIGNAL })).kind, 'committed', where);
      }
      assert.ok(read(root, LOG).endsWith(line(id, '새 페이지', 'RAG.md, 인사이트/2026.md')), where);
      assert.equal(read(root, '스터디/wiki/RAG.md'), rag(id), where);
      assert.equal(store.rows(), 0, where);
    },
  });
  assert.deepEqual([...ends].sort(), ['committed', 'interrupted', 'untouched']);
  assert.ok(seen > 30, `${seen} kills`);
}, 30_000);

test('a staged answer is filed with no model, before any memo, and its staging goes', async () => {
  const id = ulid(9);
  const w = await routedMemo({});
  mkdirSync(join(w.root, 'inbox', 'answers', '스터디'), { recursive: true });
  const filing: AnswerFiling = { id: id as AnswerId, domain: 스터디, question: '측정은 언제 하지?', answer: '먼저.', cited: [], sessionId: null, askedAt: '2026-10-29T09:00:00.000Z' };
  writeFileSync(join(w.root, 'inbox', 'answers', '스터디', `${id}.md`), renderAnswerStaging(filing));
  assert.deepEqual(await run(w.engine, '스터디', false), { kind: 'committed', job: { kind: 'file-answer', domain: 스터디, id }, verdict: 'saved' });
  assert.equal(read(w.root, LOG), `# log\n## [2026-10-29] file-answer | ${id} | 저장 | answers/2026-10-29 측정은 언제 하지.md\n`);
  assert.deepEqual(await run(w.engine, '스터디', false), { kind: 'idle' }, 'the memo waits for the model');
  assert.deepEqual((await nodeFs(w.root).list('inbox/answers/스터디' as never)), []);
});

test('a paused wiki routes and runs nothing until dotoriwiki.yaml is fixed', async () => {
  const w = await wiki({});
  await w.engine.accept(memo(1, 'x', { domain_hint: '스터디' }));
  const yaml = read(w.root, 'dotoriwiki.yaml');
  writeFileSync(join(w.root, 'dotoriwiki.yaml'), 'version: 2\n');
  assert.equal((await w.engine.routeNext(NO_SIGNAL)).kind, 'paused');
  assert.deepEqual(await run(w.engine, '스터디'), { kind: 'paused' });
  assert.equal(await w.engine.domains(), null);
  writeFileSync(join(w.root, 'dotoriwiki.yaml'), yaml);
  assert.equal((await w.engine.routeNext(NO_SIGNAL)).kind, 'routed');
  assert.deepEqual(await w.engine.domains(), ['일상', '스터디', '미루기 아카이빙']);
});
