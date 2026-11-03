/**
 * Done when 3: the model can write only under <d>/wiki/ of the memo's domain. A fake model that
 * asks to write elsewhere is refused, the attempt fails with `scope`, and nothing outside changes.
 */

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { nodeFs } from '../../fs/node';
import { memo, page, ulid, validFields } from '../../core/__tests__/helpers';
import { fakeModel, plays, turn } from '../../agent/__tests__/fake-model';
import { changed, engineOn, memoryJournal, presetWiki, read, run, NO_SIGNAL, snapshot } from './harness';

const ID = ulid(1);
const ok = page(validFields(ID), '정리한 내용.\n');

/** A memo routed to 스터디 by its hint, ready for its ingest. */
async function routed(ingest: Parameters<typeof fakeModel>[0]['ingest']) {
  const root = await presetWiki('ko');
  const model = fakeModel({ ingest });
  const engine = await engineOn(nodeFs(root), memoryJournal(), model);
  assert.equal((await engine.accept(memo(1, 'RAG 메모', { domain_hint: '스터디' }))).kind, 'created');
  assert.equal((await engine.routeNext(NO_SIGNAL)).kind, 'routed');
  return { root, model, engine, before: snapshot(root) };
}

const refusals: [string, string][] = [
  ['../일상/wiki/x.md', '일상/wiki/x.md'],
  ['../일상/wiki/x.md'.normalize('NFD'), '일상/wiki/x.md'],
  [`raw/${ID}.md`, `스터디/raw/${ID}.md`],
  ['CLAUDE.md', '스터디/CLAUDE.md'],
  ['../CLAUDE.md', 'CLAUDE.md'],
  ['../dotoriwiki.yaml', 'dotoriwiki.yaml'],
  ['../inbox/x.md', 'inbox/x.md'],
  ['hold/x.md', '스터디/hold/x.md'],
  ['wiki/../../x.md', 'x.md'],
  ['wiki/../../../x.md', 'wiki/../../../x.md'],
  ['/etc/x.md', '/etc/x.md'],
  ['wiki/a\\b.md', 'wiki/a\\b.md'],
  ['wiki/.obsidian/x.md', '스터디/wiki/.obsidian/x.md'],
  ['wiki/a.txt', '스터디/wiki/a.txt'],
];

test.each(refusals.flatMap(([target, path]) => (['write', 'edit'] as const).map((tool) => [tool, target, path] as const)))(
  '%s %j is refused: the attempt fails with scope, the page it wrote first is rolled back, and only log.md changes',
  async (tool, target, path) => {
    const outside = tool === 'write' ? turn.write(target, ok) : turn.edit(target, '#', '# x');
    const { root, model, engine, before } = await routed(plays(turn.write('wiki/ok.md', ok), outside, turn.finish('created')));
    const r = await run(engine, '스터디');
    assert.deepEqual(r, {
      kind: 'retrying',
      job: { kind: 'ingest', domain: '스터디', id: ID },
      attempt: 1,
      problems: [{ rule: 'scope', path, detail: 'write outside wiki/' }],
    });
    assert.equal(model.requests.filter((q) => q.role === 'ingest').length, 2, 'no turn after the refusal');
    assert.deepEqual(changed(before, snapshot(root)), ['스터디/wiki/log.md']);
    assert.equal(read(root, '스터디/wiki/log.md'), `# log\n## [2026-10-29] ingest | ${ID} | 실패 1/3 | scope ${path}: write outside wiki/\n`);
  },
);

test('index.md and log.md answer an error, the run goes on, and the engine writes both', async () => {
  const { root, model, engine } = await routed(plays(turn.write('wiki/index.md', 'mine'), turn.write('wiki/LOG.md', 'mine'), turn.write('wiki/RAG.md', ok), turn.finish('created')));
  assert.equal((await run(engine, '스터디')).kind, 'committed');
  const answers = model.requests.at(-1)!.input.filter((i) => i.type === 'function_call_output').map((i) => (i as { output: string }).output);
  assert.deepEqual(answers.slice(0, 2), ['error: the server writes wiki/index.md; only read it', 'error: the server writes wiki/LOG.md; only read it']);
  assert.equal(read(root, '스터디/wiki/log.md'), `# log\n## [2026-10-29] ingest | ${ID} | 새 페이지 | RAG.md\n`);
  assert.match(read(root, '스터디/wiki/index.md'), /^# 스터디 색인\n/);
});

test('_review.md takes lines added at its end and nothing else', async () => {
  const { root, engine } = await routed(plays(
    turn.read('wiki/_review.md'),
    turn.write('wiki/_review.md', '# 다른 제목\n'),
    turn.write('wiki/_review.md', '# 검토할 것\n\n- 이전 메모\n- 새로 본 것\n'),
    turn.finish('unchanged'),
  ));
  writeFileSync(`${root}/스터디/wiki/_review.md`, '# 검토할 것\n\n- 이전 메모\n');
  assert.equal((await run(engine, '스터디')).kind, 'committed');
  assert.equal(read(root, '스터디/wiki/_review.md'), '# 검토할 것\n\n- 이전 메모\n- 새로 본 것\n');
});
