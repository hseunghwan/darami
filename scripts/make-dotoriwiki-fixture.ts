/**
 * Writes src/core/__tests__/fixtures/made-by-dotoriwiki/: a lived-in wiki that dotoriwiki itself
 * made, for compat.test.ts. Run by hand under Node 24, never in CI, against a dotoriwiki checkout
 * at 91f0aac with its dependencies installed:
 *
 *   node scripts/make-dotoriwiki-fixture.ts <dotoriwiki-checkout> [out-dir]
 *
 * It drives dotoriwiki's openWiki with the fakes in its test/helpers.ts, in a temp git work tree,
 * and writes nothing into the checkout. The copy leaves out .git, .gateway, and _originals, and
 * the wiki's .gitignore, whose `inbox/*` would keep the inbox memos out of darami's own git.
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';

const [dotori, out = join(import.meta.dirname, '..', 'src', 'core', '__tests__', 'fixtures', 'made-by-dotoriwiki')] = process.argv.slice(2);
if (!dotori) throw new Error('usage: node scripts/make-dotoriwiki-fixture.ts <dotoriwiki-checkout> [out-dir]');
const from = (p: string) => import(resolve(dotori, p));
const h = await from('test/helpers.ts');
const { GALAXY, jpegWithExif, PLAIN_JPEG } = await from('test/exif.ts');

const 스터디 = '스터디';
const 일상 = '일상';
const SEOUL = { lat: 37.5665, lon: 126.978, place: '중구 태평로1가', address: '서울특별시 중구 세종대로 110' };

const root: string = await h.tempWiki('ko');
const yamlPath = join(root, 'dotoriwiki.yaml');
const yaml = await fs.readFile(yamlPath, 'utf8');
await fs.writeFile(
  yamlPath,
  `${yaml.replace('    agents_may_read: true\n', '    agents_may_read: true\n    model_profile: strong\n')}feeds:\n  geeknews: { domain: 스터디 }\n`,
);

const llm = h.fakeLlm();
const fetch = h.fakeFetch();
fetch.respond = async (url: string) =>
  url.includes('dead') ? { kind: 'article', status: 'failed', title: null, detail: 'HTTP 404' } : { kind: 'article', status: 'ok', title: `제목 ${url}`, text: `본문 ${url}` };
const wiki = await h.open(root, llm, { fetchSource: fetch, modelProfiles: ['default', 'strong'] });

const page = (id: string, type: string, summary: string, body?: string) => h.page(h.validFields(id, { type, summary }), body);
const ids = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [n, h.ulid(n) as string]));
llm.editWith = async (req: { cwd: string; prompt: string }) => {
  const id: string = h.rawIdOf(req);
  const inStudy = req.cwd.endsWith(스터디);
  if (id === ids[2]) await h.modelWrites(req, 'wiki/RAG.md', page(id, 'concept', '청크 크기와 검색', '청크는 512 토큰.\n'));
  else if (id === ids[3]) await h.modelWrites(req, 'wiki/인사이트/2026.md', page(id, 'insight', '짧은 깨달음', '- 측정 먼저. [[RAG]]\n'));
  else if (id === ids[4]) return { kind: 'finished', verdict: 'unchanged', pages: [] };
  else if (id === ids[5]) await h.modelWrites(req, 'wiki/주제/놀이터.md', page(id, 'theme', '친구와 놀이터', `친구랑 놀이터에 갔다. 사진에서 본 그네.\n\n![[${id}-1.jpg]]\n`));
  else if (id === ids[6] && inStudy) await h.modelWrites(req, 'wiki/a.md', page(id, 'concept', '깨진 링크', '[[없음]]\n'));
  else if (id === ids[6]) await h.modelWrites(req, 'wiki/ME.md', page(id, 'me', '나의 경향', '아침에 쓴다.\n'));
  else throw new Error(`no edit planned for ${id}`);
  return { kind: 'finished', verdict: 'created', pages: [] };
};
llm.classifyWith = async () => ({ kind: 'classified', domain: 일상, confidence: 0.3, reason: '애매함' });

const accept = async (m: unknown) => assert.equal((await wiki.accept(m)).kind, 'created');
const upload = async (id: string, n: number, bytes: Uint8Array, origin: string) => {
  assert.equal((await wiki.storePhoto(id, n, bytes)).kind, 'stored');
  return { n, origin, place: origin === 'gallery' ? '종로구 사직동' : null, address: null };
};

await accept(h.memo(2, '읽어볼 글 https://example.com/rag 그리고 https://example.com/dead', { source: 'share', domain_hint: 스터디 }));
await accept(h.memo(3, '[GeekNews] 측정 먼저\n원문: https://example.com/measure\n게시: 2026-10-28\n토론: https://news.hada.io/topic?id=1\n\n요약 속 링크 https://other.example/b', { source: 'feed', domain_hint: 스터디 }));
await accept(h.memo(4, '노트 앱에서 RAG 실험 중', { source: 'agent', domain_hint: 스터디, context: { project: 'notes-app', cwd: '/w/notes-app', branch: 'main' } }));
const photos = [await upload(ids[5]!, 1, jpegWithExif(GALAXY), 'gallery'), await upload(ids[5]!, 2, PLAIN_JPEG, 'camera')];
await accept(h.memo(5, '친구랑 놀이터', { domain_hint: 일상, attachments: photos, location: SEOUL }));
await accept(h.memo(6, '세 번 실패할 메모', { domain_hint: 스터디 }));
await accept(h.memo(7, '애매한 메모'));
for (const want of ['routed', 'routed', 'routed', 'routed', 'routed', 'held', 'idle']) assert.equal((await wiki.routeNext()).kind, want);

const runUntilIdle = async (d: string, want: readonly string[]) => {
  const got: string[] = [];
  for (let r = await wiki.runNext(d); r.kind !== 'idle'; r = await wiki.runNext(d)) got.push(r.kind);
  assert.deepEqual(got, want, d);
};
await runUntilIdle(스터디, ['committed', 'committed', 'committed', 'retrying', 'retrying', 'gave-up']);
assert.equal((await wiki.move(ids[6], 일상)).kind, 'released');
await runUntilIdle(일상, ['committed', 'committed']);

const answer = (n: number, question: string, cited: readonly { domain: string; page: string }[]) =>
  ({ id: ids[n], domain: 스터디, question, answer: '청크 512 토큰.', cited, sessionId: n === 8 ? 's1' : null, askedAt: '2026-10-29T09:00:00.000Z' });
assert.equal((await wiki.fileAnswer(answer(8, 'RAG에서 알아낸 게 뭐였지?', [{ domain: 스터디, page: 'RAG' }]))).kind, 'created');
await runUntilIdle(스터디, ['committed']);
assert.equal((await wiki.fileAnswer(answer(9, '측정은 언제 하지?', []))).kind, 'created');
await accept(h.memo(1, '아직 분류 전인 메모'));
await wiki.close();

await fs.rm(out, { recursive: true, force: true });
await fs.cp(root, out, { recursive: true, filter: (src) => !['.git', '.gitignore', '.gateway', '_originals'].some((d) => src === join(root, d)) });
await fs.rm(root, { recursive: true, force: true });
console.log(`wrote ${out}`);
