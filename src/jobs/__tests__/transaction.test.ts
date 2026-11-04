import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Fs } from '../../core/fs';
import type { WikiPath } from '../../core/layout';
import { textFor } from '../../core/text';
import type { DomainName } from '../../core/types';
import { nodeFs } from '../../fs/node';
import { openJournal, type JournalJob, type Recovered, type Words } from '../transaction';
import { everyKill, memoryJournal, presetWiki, read, snapshot, type Store } from './harness';

const 스터디 = '스터디' as DomainName;
const 일상 = '일상' as DomainName;
const A = '01JB8ZQ4M3T9X7K2W5R6N8P001';
const at = (p: string) => p as WikiPath;
const KO: Words = { locale: 'ko', today: '2026-10-29', t: textFor('ko') };
const job = (attempt = 1): JournalJob => ({ kind: 'ingest', id: A, attempt });
const LOG = '스터디/wiki/log.md';
const line = (third: string, fourth: string) => `## [2026-10-29] ingest | ${A} | ${third} | ${fourth}\n`;
const open = (fs: Fs, store: Store, recovered: Recovered[] = [], words: Words | null = KO) => openJournal({ fs, store, words: async () => words, onRecovered: (r) => recovered.push(r) });

/** The ko preset with one page that a job changes. */
async function fresh() {
  const root = await presetWiki('ko');
  writeFileSync(join(root, '스터디', 'wiki', '기존.md'), 'old\n');
  return { root, store: memoryJournal() };
}

/** `tree` with `edits` applied: a path to its new text, or null for a file that is gone. */
const withEdits = (tree: Map<string, string>, edits: Record<string, string | null>) => {
  const out = new Map(tree);
  for (const [p, t] of Object.entries(edits)) {
    if (t === null) out.delete(p);
    else out.set(p, Buffer.from(t, 'utf8').toString('latin1'));
  }
  return [...out].sort(([a], [b]) => (a < b ? -1 : 1));
};
const asList = (m: Map<string, string>) => [...m].sort(([a], [b]) => (a < b ? -1 : 1));

async function commitOne(fs: Fs, store: Store) {
  const tx = await open(fs, store).beginJob(스터디, job());
  try {
    await tx.write(at('스터디/wiki/RAG.md'), '새 페이지\n');
    await tx.write(at('스터디/wiki/기존.md'), 'changed\n');
    await tx.commit('created', '# 색인\n');
  } finally {
    tx.release();
  }
}

test('a committed job leaves its pages, index.md, and one applied line listing changed pages first, then new ones', async () => {
  const { root, store } = await fresh();
  const before = snapshot(root);
  await commitOne(nodeFs(root), store);
  assert.deepEqual(asList(snapshot(root)), withEdits(before, {
    '스터디/wiki/RAG.md': '새 페이지\n',
    '스터디/wiki/기존.md': 'changed\n',
    '스터디/wiki/index.md': '# 색인\n',
    [LOG]: `# log\n${line('새 페이지', '기존.md, RAG.md')}`,
  }));
  assert.equal(store.rows(), 0);
});

test('a failed job is rolled back before its line, and the third gives up with a _review.md note', async () => {
  const { root, store } = await fresh();
  const before = snapshot(root);
  const fs = nodeFs(root);
  const j = open(fs, store);
  const problem = { rule: 'broken-link' as const, path: '스터디/wiki/RAG.md', detail: '[[없음]] does not resolve' };
  const reason = 'broken-link 스터디/wiki/RAG.md: [[없음]] does not resolve';
  for (const attempt of [1, 2, 3]) {
    const tx = await j.beginJob(스터디, job(attempt));
    await tx.write(at('스터디/wiki/RAG.md'), '[[없음]]\n');
    await tx.write(at('스터디/wiki/기존.md'), 'changed\n');
    assert.equal(await tx.fail([problem]), attempt < 3 ? 'retrying' : 'gave-up');
  }
  assert.deepEqual(asList(snapshot(root)), withEdits(before, {
    [LOG]: `# log\n${line('실패 1/3', reason)}${line('실패 2/3', reason)}${line('포기 3/3', reason)}`,
    '스터디/wiki/_review.md': `# 검토할 것\n\n- [2026-10-29] ingest \`${A}\` 포기 3/3: ${reason}\n`,
  }));
  assert.equal(store.rows(), 0);
});

test('an abandoned job leaves the folder as it was and writes no line', async () => {
  const { root, store } = await fresh();
  const before = snapshot(root);
  const tx = await open(nodeFs(root), store).beginJob(스터디, job());
  await tx.write(at('스터디/wiki/RAG.md'), 'x\n');
  await tx.write(at('스터디/wiki/기존.md'), 'changed\n');
  await tx.abandon();
  assert.deepEqual(asList(snapshot(root)), asList(before));
  assert.equal(store.rows(), 0);
});

test('one live job per domain, and the journal names the ingest it holds open', async () => {
  const { root, store } = await fresh();
  const j = open(nodeFs(root), store);
  const tx = await j.beginJob(스터디, job());
  await assert.rejects(j.beginJob(스터디, job()));
  const other = await j.beginJob(일상, { kind: 'ingest', id: 'B', attempt: 1 });
  assert.deepEqual([...(await j.running())].sort(), [[스터디, A], [일상, 'B']]);
  await tx.abandon();
  await other.abandon();
  assert.deepEqual([...(await j.running())], []);
});

test('a line outside a job is written whole, or not at all when the ledger says nothing to do', async () => {
  const { root, store } = await fresh();
  const j = open(nodeFs(root), store);
  assert.equal(await j.appendLine(스터디, (l) => (l.history('ingest', A).terminal ? { job: 'ingest', id: A, outcome: { kind: 'retry' } } : null)), false);
  assert.equal(await j.appendLine(스터디, () => ({ job: 'ingest', id: A, outcome: { kind: 'moved', to: '일상' } })), true);
  assert.equal(read(root, LOG), `# log\n${line('이동 → 일상', '-')}`);
});

test('a stale job waits while dotoriwiki.yaml is broken, then closes with one interrupted line', async () => {
  const { root, store } = await fresh();
  const tx = await open(nodeFs(root), store).beginJob(스터디, job());
  await tx.write(at('스터디/wiki/RAG.md'), 'x\n');
  tx.release();
  await open(nodeFs(root), store, [], null).recover();
  assert.equal(store.rows(), 1, 'kept while the config is broken');
  const recovered: Recovered[] = [];
  await open(nodeFs(root), store, recovered).recover();
  assert.equal(read(root, LOG), `# log\n${line('중단 1/3', 'app stopped mid-job')}`);
  assert.deepEqual(recovered, [{ domain: 스터디, slot: 'job', job: job(), as: 'interrupted' }]);
  assert.equal(store.rows(), 0);
});

/** The end states a kill may leave, as edits of the folder before the job. */
async function outcomes(states: Record<string, Record<string, string | null>>, act: (fs: Fs, store: Store) => Promise<void>) {
  const base = snapshot((await fresh()).root);
  const want = Object.entries(states).map(([name, edits]) => [name, JSON.stringify(withEdits(base, edits))] as const);
  const seen = new Set<string>();
  const runs = await everyKill({
    fresh,
    act,
    reopen: async (fs, store) => open(fs, store).recover(),
    check: (root, store, where) => {
      const got = JSON.stringify(asList(snapshot(root)));
      const match = want.find(([, w]) => w === got);
      assert.ok(match, `${where}: the folder is none of ${Object.keys(states).join(', ')}:\n${read(root, LOG)}`);
      assert.equal(store.rows(), 0, where);
      seen.add(match[0]);
    },
  });
  return { runs, seen: [...seen].sort() };
}

test('a kill anywhere in a committing job, and anywhere in its recovery, leaves it committed or interrupted with one line', async () => {
  const r = await outcomes({
    untouched: {},
    committed: { '스터디/wiki/RAG.md': '새 페이지\n', '스터디/wiki/기존.md': 'changed\n', '스터디/wiki/index.md': '# 색인\n', [LOG]: `# log\n${line('새 페이지', '기존.md, RAG.md')}` },
    interrupted: { [LOG]: `# log\n${line('중단 1/3', 'app stopped mid-job')}` },
  }, commitOne);
  assert.deepEqual(r.seen, ['committed', 'interrupted', 'untouched']);
  assert.ok(r.runs > 50, `${r.runs} kills`);
}, 30_000);

test('a kill anywhere in a failing job leaves it failed or interrupted, its pages as they were', async () => {
  const reason = 'broken-link 스터디/wiki/RAG.md: [[없음]] does not resolve';
  const r = await outcomes({
    untouched: {},
    failed: { [LOG]: `# log\n${line('실패 1/3', reason)}` },
    interrupted: { [LOG]: `# log\n${line('중단 1/3', 'app stopped mid-job')}` },
  }, async (fs, store) => {
    const tx = await open(fs, store).beginJob(스터디, job());
    await tx.write(at('스터디/wiki/RAG.md'), '[[없음]]\n');
    await tx.write(at('스터디/wiki/기존.md'), 'changed\n');
    await tx.fail([{ rule: 'broken-link', path: '스터디/wiki/RAG.md', detail: '[[없음]] does not resolve' }]);
  });
  assert.deepEqual(r.seen, ['failed', 'interrupted', 'untouched']);
}, 30_000);

test('a kill anywhere in a third attempt gives up once, with one _review.md note', async () => {
  const note = (reason: string) => `# 검토할 것\n\n- [2026-10-29] ingest \`${A}\` 포기 3/3: ${reason}\n`;
  const reason = 'empty 스터디/wiki/RAG.md: page has no body';
  const r = await outcomes({
    untouched: {},
    'gave up': { [LOG]: `# log\n${line('포기 3/3', reason)}`, '스터디/wiki/_review.md': note(reason) },
    'gave up interrupted': { [LOG]: `# log\n${line('포기 3/3', 'app stopped mid-job')}`, '스터디/wiki/_review.md': note('app stopped mid-job') },
  }, async (fs, store) => {
    const tx = await open(fs, store).beginJob(스터디, job(3));
    await tx.write(at('스터디/wiki/RAG.md'), '---\n---\n');
    await tx.fail([{ rule: 'empty', path: '스터디/wiki/RAG.md', detail: 'page has no body' }]);
  });
  assert.deepEqual(r.seen, ['gave up', 'gave up interrupted', 'untouched']);
}, 30_000);

test('a kill anywhere in a lone line leaves the line there or not, never torn', async () => {
  const r = await outcomes({
    untouched: {},
    written: { [LOG]: `# log\n${line('재시도', '-')}` },
  }, async (fs, store) => {
    await open(fs, store).appendLine(스터디, () => ({ job: 'ingest', id: A, outcome: { kind: 'retry' } }));
  });
  assert.deepEqual(r.seen, ['untouched', 'written']);
}, 30_000);

test("the committed view reads a live job's paths as they were, hides what it made, and follows the folder once it commits or rolls back", async () => {
  const { root, store } = await fresh();
  const fs = nodeFs(root);
  const journal = open(fs, store);
  const view = journal.committedFs();
  const old = at('스터디/wiki/기존.md');
  const made = at('스터디/wiki/새것.md');
  const tx = await journal.beginJob(스터디, job());
  await tx.write(old, 'changed\n');
  await tx.write(made, 'new\n');
  assert.equal(await fs.readText(old), 'changed\n', 'the folder holds the live job\'s text');
  assert.equal(await view.readText(old), 'old\n');
  assert.equal(await view.readText(made), null);
  assert.ok(!(await view.listTree(at('스터디/wiki'))).includes(made));
  assert.deepEqual((await view.list(at('스터디/wiki'))).filter((n) => n.endsWith('.md')), ['log.md', '기존.md']);
  await tx.commit('created', '# 색인\n');
  tx.release();
  assert.equal(await view.readText(old), 'changed\n');
  assert.equal(await view.readText(made), 'new\n');
  assert.ok((await view.listTree(at('스터디/wiki'))).includes(made));

  const again = await journal.beginJob(스터디, job(2));
  await again.write(old, 'torn');
  assert.equal(await view.readText(old), 'changed\n');
  await again.abandon();
  again.release();
  assert.equal(await view.readText(old), 'changed\n');
  // @ts-expect-error the committed view has no write
  assert.equal(view.write, undefined);
  assert.deepEqual(Object.keys(view).sort(), ['list', 'listTree', 'readBytes', 'readText']);
});
