/**
 * dotoriwiki's own scenario, from scripts/make-dotoriwiki-fixture.ts, replayed through darami's
 * engine with the same fake model answers: the folder it leaves is made-by-dotoriwiki byte for byte.
 * That fixture is what dotoriwiki 91f0aac wrote, so every ledger line, index.md, _review.md, memo
 * file, routing, and answer page here is held to dotoriwiki's bytes, not to darami's own output.
 *
 * Two things are put in by hand, as P6 will do them: memo 5 carries photos, which accept refuses
 * until P6, so its inbox file is written as dotoriwiki's accept wrote it; and the link sidecars of
 * memos 2 and 3 are copied in, because P3 does not fetch links.
 */

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMemoFile, renderAnswerStaging, renderMemoFile, type AnswerFiling } from '../../core/pages';
import type { AnswerId, DomainName, MemoId } from '../../core/types';
import { nodeFs } from '../../fs/node';
import { memo, page, ulid, validFields } from '../../core/__tests__/helpers';
import { fakeModel, turn } from '../../agent/__tests__/fake-model';
import type { ModelRequest } from '../../agent/model';
import { engineOn, memoryJournal, NO_SIGNAL, presetWiki, run, snapshot } from './harness';

const FIXTURE = join(__dirname, '..', '..', 'core', '__tests__', 'fixtures', 'made-by-dotoriwiki');
const 스터디 = '스터디' as DomainName;
const 일상 = '일상' as DomainName;
const ids = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [n, ulid(n)])) as Record<number, string>;
const SEOUL = { lat: 37.5665, lon: 126.978, place: '중구 태평로1가', address: '서울특별시 중구 세종대로 110' };
const pageOf = (id: string, type: string, summary: string, body: string) => page(validFields(id, { type, summary }), body);

/** The memo id the ingest prompt names. */
const memoOf = (req: ModelRequest) => /raw\/([0-9A-Z]{26})\.md/.exec(JSON.stringify(req.input[0]))![1]!;

test('replaying dotoriwiki\'s scenario leaves made-by-dotoriwiki, byte for byte', async () => {
  const root = await presetWiki('ko');
  const yaml = readFileSync(join(root, 'dotoriwiki.yaml'), 'utf8');
  writeFileSync(join(root, 'dotoriwiki.yaml'), `${yaml.replace('    agents_may_read: true\n', '    agents_may_read: true\n    model_profile: strong\n')}feeds:\n  geeknews: { domain: 스터디 }\n`);
  cpSync(join(FIXTURE, '_attachments'), join(root, '_attachments'), { recursive: true });

  let tries6 = 0;
  const model = fakeModel({
    classify: () => turn.route('일상', 0.3, '애매함'),
    ingest: (req, n) => {
      const id = memoOf(req);
      if (n === 2) return turn.finish('created');
      if (id === ids[2]) return turn.write('wiki/RAG.md', pageOf(id, 'concept', '청크 크기와 검색', '청크는 512 토큰.\n'));
      if (id === ids[3]) return turn.write('wiki/인사이트/2026.md', pageOf(id, 'insight', '짧은 깨달음', '- 측정 먼저. [[RAG]]\n'));
      if (id === ids[4]) return turn.finish('unchanged');
      if (id === ids[5]) return turn.write('wiki/주제/놀이터.md', pageOf(id, 'theme', '친구와 놀이터', `친구랑 놀이터에 갔다. 사진에서 본 그네.\n\n![[${id}-1.jpg]]\n`));
      if (id === ids[6] && ++tries6 <= 3) return turn.write('wiki/a.md', pageOf(id, 'concept', '깨진 링크', '[[없음]]\n'));
      if (id === ids[6]) return turn.write('wiki/ME.md', pageOf(id, 'me', '나의 경향', '아침에 쓴다.\n'));
      throw new Error(`no edit planned for ${id}`);
    },
  });
  const fs = nodeFs(root);
  const engine = await engineOn(fs, memoryJournal(), model);
  const accept = async (m: ReturnType<typeof memo>) => assert.equal((await engine.accept(m)).kind, 'created');

  await accept(memo(2, '읽어볼 글 https://example.com/rag 그리고 https://example.com/dead', { source: 'share', domain_hint: 스터디 }));
  await accept(memo(3, '[GeekNews] 측정 먼저\n원문: https://example.com/measure\n게시: 2026-10-28\n토론: https://news.hada.io/topic?id=1\n\n요약 속 링크 https://other.example/b', { source: 'feed', domain_hint: 스터디 }));
  await accept(memo(4, '노트 앱에서 RAG 실험 중', { source: 'agent', domain_hint: 스터디, context: { project: 'notes-app', cwd: '/w/notes-app', branch: 'main' } }));
  const photo = parseMemoFile(readFileSync(join(FIXTURE, '일상', 'raw', `${ids[5]}.md`), 'utf8'));
  assert.ok(photo.ok);
  assert.equal(photo.value.memo.text, '친구랑 놀이터');
  assert.deepEqual(photo.value.memo.location, SEOUL);
  writeFileSync(join(root, 'inbox', `${ids[5]}.md`), renderMemoFile(photo.value.memo, null));
  await accept(memo(6, '세 번 실패할 메모', { domain_hint: 스터디 }));
  await accept(memo(7, '애매한 메모'));
  const routed: string[] = [];
  for (let i = 0; i < 7; i++) routed.push((await engine.routeNext(NO_SIGNAL)).kind);
  assert.deepEqual(routed, ['routed', 'routed', 'routed', 'routed', 'routed', 'held', 'idle']);
  for (const n of [2, 3]) cpSync(join(FIXTURE, '스터디', 'raw', `${ids[n]}.source.md`), join(root, '스터디', 'raw', `${ids[n]}.source.md`));

  const runUntilIdle = async (d: string, want: readonly string[]) => {
    const got: string[] = [];
    for (let r = await run(engine, d); r.kind !== 'idle'; r = await run(engine, d)) got.push(r.kind);
    assert.deepEqual(got, want, d);
  };
  await runUntilIdle(스터디, ['committed', 'committed', 'committed', 'retrying', 'retrying', 'gave-up']);
  assert.deepEqual(await engine.move(ids[6] as MemoId, 일상), { kind: 'released', domain: 일상 });
  await runUntilIdle(일상, ['committed', 'committed']);

  const stage = (n: number, question: string, cited: AnswerFiling['cited']) => {
    const f: AnswerFiling = { id: ids[n] as AnswerId, domain: 스터디, question, answer: '청크 512 토큰.', cited, sessionId: n === 8 ? 's1' : null, askedAt: '2026-10-29T09:00:00.000Z' };
    mkdirSync(join(root, 'inbox', 'answers', 스터디), { recursive: true });
    writeFileSync(join(root, 'inbox', 'answers', 스터디, `${f.id}.md`), renderAnswerStaging(f));
  };
  stage(8, 'RAG에서 알아낸 게 뭐였지?', [{ domain: 스터디, page: 'RAG' }]);
  await runUntilIdle(스터디, ['committed']);
  stage(9, '측정은 언제 하지?', []);
  await accept(memo(1, '아직 분류 전인 메모'));

  // The fixture leaves out .gitignore, as the script that made it did.
  const ours = snapshot(root);
  ours.delete('.gitignore');
  const theirs = snapshot(FIXTURE);
  assert.deepEqual([...ours.keys()], [...theirs.keys()], 'the same files');
  for (const [p, bytes] of theirs) assert.equal(Buffer.from(ours.get(p)!, 'latin1').toString('utf8'), Buffer.from(bytes, 'latin1').toString('utf8'), p);
});
