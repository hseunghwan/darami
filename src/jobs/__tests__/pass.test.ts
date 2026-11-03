/**
 * One runner pass over the real engine reads each memo folder and ledger once: the engine's own
 * writes keep the book exact inside the pass, and the next pass reads the folder again.
 */

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderMemoFile } from '../../core/pages';
import { nodeFs } from '../../fs/node';
import { memo, ulid } from '../../core/__tests__/helpers';
import { fakeModel, turn } from '../../agent/__tests__/fake-model';
import type { Engine } from '../engine';
import { createRunner } from '../runner';
import { countingFs, engineOn, memoryJournal, presetWiki, read, run, NO_SIGNAL } from './harness';

const DOMAINS = ['스터디', '일상', '미루기 아카이빙'];

async function filedWiki() {
  const root = await presetWiki('ko');
  const fs = countingFs(nodeFs(root));
  const e = await engineOn(fs, memoryJournal(), fakeModel({ ingest: () => turn.finish('unchanged') }));
  for (let n = 1; n <= 6; n++) await e.accept(memo(n, `메모 ${n}`, { domain_hint: DOMAINS[n % 3] }));
  for (let n = 1; n <= 6; n++) await e.routeNext(NO_SIGNAL);
  for (const d of DOMAINS) for (let i = 0; i < 2; i++) await run(e, d);
  return { root, fs, e };
}

const runnerOn = (e: Engine) => createRunner({ engine: async () => e, setTimer: () => () => {}, now: () => 0, onReport: () => {} });

test('an idle pass lists each memo folder once, and reads each ledger once', async () => {
  const w = await filedWiki();
  w.fs.reset();
  await runnerOn(w.e).trigger();
  const memoFolders = ['inbox', ...DOMAINS.flatMap((d) => [`${d}/hold`, `${d}/raw`])];
  const answers = DOMAINS.map((d) => `inbox/answers/${d}`);
  assert.deepEqual(w.fs.listed(), [...memoFolders, ...answers].sort());
  assert.equal(w.fs.calls('readText', (p) => p.endsWith('/wiki/log.md')), DOMAINS.length);
});

test('a pass files a memo it routed itself, and the next pass sees a memo copied in from outside', async () => {
  const w = await filedWiki();
  const runner = runnerOn(w.e);
  await w.e.accept(memo(7, '새 메모', { domain_hint: '스터디' }));
  await runner.trigger();
  assert.match(read(w.root, '스터디/wiki/log.md'), new RegExp(`${ulid(7)} \\| 정리할 거리 없음`));
  writeFileSync(join(w.root, '일상', 'raw', `${ulid(8)}.md`), renderMemoFile({ ...memo(8, '밖에서 온 메모', { domain_hint: '일상' }), attachments: [] }, { by: 'hint' }));
  await runner.trigger();
  assert.match(read(w.root, '일상/wiki/log.md'), new RegExp(`${ulid(8)} \\| 정리할 거리 없음`));
});
