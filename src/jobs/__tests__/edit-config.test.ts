import assert from 'node:assert/strict';
import { draftOf, type DomainDraft } from '../../core/config-edit';
import type { Fs } from '../../core/fs';
import { paths } from '../../core/layout';
import type { DomainName } from '../../core/types';
import { readConfig } from '../../core/wiki';
import { nodeFs } from '../../fs/node';
import { memo, ulid } from '../../core/__tests__/helpers';
import { fakeModel, plays, turn } from '../../agent/__tests__/fake-model';
import { engineOn, memoryJournal, NO_SIGNAL, presetWiki, read, run } from './harness';

const machine = { modelProfiles: new Set<string>() };
const RECIPES: DomainDraft = { description: '해 본 요리', pageTypes: [{ type: 'recipe', description: '요리 하나', example: null }] };
const KO_DOMAINS = ['일상', '스터디', '미루기 아카이빙'];

/** A promise and the function that settles it. */
function signal(): { readonly wait: Promise<void>; readonly fire: () => void } {
  let fire!: () => void;
  const wait = new Promise<void>((r) => (fire = r));
  return { wait, fire };
}

test('a config read while an edit writes dotoriwiki.yaml waits for the write and sees the new file, never a cut one', async () => {
  const root = await presetWiki('ko');
  const inner = nodeFs(root);
  const truncated = signal();
  const release = signal();
  const slow: Fs = {
    ...inner,
    async write(path, text) {
      if (path !== paths.config) return inner.write(path, text);
      await inner.write(path, '');
      truncated.fire();
      await release.wait;
      return inner.write(path, text);
    },
  };
  const engine = await engineOn(slow, memoryJournal(), fakeModel({}));
  const saved = engine.editConfig({ kind: 'add', name: '요리', want: RECIPES });
  await truncated.wait;
  assert.equal(await inner.readText(paths.config), '', 'the file is empty for now');
  const domains = engine.domains();
  release.fire();
  assert.equal((await saved).kind, 'saved');
  assert.deepEqual(await domains, [...KO_DOMAINS, '요리']);
});

test('an edit waits for a config read in flight, so that read sees the whole old file', async () => {
  const root = await presetWiki('ko');
  const inner = nodeFs(root);
  let writeStarted = false;
  let holdReads = false;
  const reading = signal();
  const release = signal();
  const slow: Fs = {
    ...inner,
    async readText(path) {
      const text = await inner.readText(path);
      if (path === paths.config && holdReads) {
        reading.fire();
        await release.wait;
      }
      return text;
    },
    async write(path, text) {
      if (path === paths.config) writeStarted = true;
      return inner.write(path, text);
    },
  };
  const engine = await engineOn(slow, memoryJournal(), fakeModel({}));
  holdReads = true;
  const domains = engine.domains();
  await reading.wait;
  holdReads = false;
  const saved = engine.editConfig({ kind: 'add', name: '요리', want: RECIPES });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(writeStarted, false, 'the write waits for the read');
  release.fire();
  assert.deepEqual(await domains, KO_DOMAINS);
  assert.equal((await saved).kind, 'saved');
  assert.equal(writeStarted, true);
});

test('after an add, the engine routes a memo to the new domain and files it there; after a description edit, the classifier reads it', async () => {
  const root = await presetWiki('ko');
  const id = ulid(1);
  const model = fakeModel({ classify: () => turn.route('스터디', 0.9, 'r'), ingest: plays(turn.finish('unchanged')) });
  const engine = await engineOn(nodeFs(root), memoryJournal(), model);
  assert.equal((await engine.editConfig({ kind: 'add', name: '요리', want: RECIPES })).kind, 'saved');
  await engine.accept(memo(1, '김치찌개 끓인 법', { domain_hint: '요리' }));
  assert.deepEqual(await engine.routeNext(NO_SIGNAL), { kind: 'routed', id, domain: '요리', routing: { by: 'hint' } });
  assert.deepEqual(await run(engine, '요리'), { kind: 'committed', job: { kind: 'ingest', domain: '요리' as DomainName, id }, verdict: 'unchanged' });
  assert.match(read(root, '요리/wiki/log.md'), new RegExp(`ingest \\| ${id} \\|`));

  const now = await readConfig(nodeFs(root), machine);
  assert.ok(now?.ok);
  const seen = draftOf(now.config.domains.get('스터디' as DomainName)!);
  assert.equal((await engine.editConfig({ kind: 'domain', name: '스터디' as DomainName, seen, want: { ...seen, description: '직접 해본 것' } })).kind, 'saved');
  await engine.accept(memo(2, '아무 메모'));
  await engine.routeNext(NO_SIGNAL);
  assert.match(model.requests.at(-1)!.instructions, /\| `스터디` \| 직접 해본 것 \|/);
});
