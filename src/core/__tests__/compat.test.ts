/**
 * A wiki dotoriwiki 91f0aac made reads back through the node adapter, and what darami renders for
 * the same values is what is on disk, byte for byte. fixtures/made-by-dotoriwiki/ comes from
 * scripts/make-dotoriwiki-fixture.ts. The port has no listing yet, so node:fs finds the files.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { nodeFs } from '../../fs/node';
import { parseLedger } from '../ledger';
import { parseWikiPath, paths } from '../layout';
import {
  check, namesOf, pageMeta, parseAnswerStaging, parseMemoFile, parsePageRef, renderAnswerStaging, renderIndex, renderMemoFile, roleOf,
  type Change, type MemoSource,
} from '../pages';
import { parseSourceFile, renderSourceFile } from '../sources';
import { textFor } from '../text';
import type { AnswerId, DomainName } from '../types';
import { readConfig } from '../wiki';

const ROOT = join(__dirname, 'fixtures', 'made-by-dotoriwiki');
const fs = nodeFs(ROOT);
const DOMAINS = ['일상', '스터디', '미루기 아카이빙'] as DomainName[];
const ko = textFor('ko');
const id = (n: number) => `01JB8ZQ4M3T9X7K2W5R6N8P${String(n).padStart(3, '0')}`;

/** Every file under dir, as sorted paths relative to the wiki root, dot segments dropped, in this realm's Array. [] when dir is missing. */
function files(dir: string): string[] {
  if (!existsSync(join(ROOT, dir))) return [];
  return [...readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })]
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(ROOT.length + 1).normalize('NFC'))
    .filter((p) => !p.split('/').some((s) => s.startsWith('.')))
    .sort();
}

const read = async (path: string) => {
  const text = await fs.readText(parseWikiPath(path)!);
  assert.ok(text !== null, path);
  return text;
};

test('its dotoriwiki.yaml opens, feeds: and model_profile: included', async () => {
  const r = await readConfig(fs, { modelProfiles: new Set() });
  assert.ok(r?.ok);
  assert.deepEqual([...r.config.domains.keys()], DOMAINS);
  assert.deepEqual(r.warnings.map((w) => w.key), ['domains.스터디.model_profile'], 'darami knows no profiles yet: a warning, never a problem');
});

test('every memo file parses and renders back to its bytes', async () => {
  const memoFiles = [...files('inbox').filter((p) => /^inbox\/[^/]+\.md$/.test(p)), ...DOMAINS.flatMap((d) => [...files(`${d}/raw`), ...files(`${d}/hold`)]).filter((p) => !p.endsWith('.source.md'))];
  assert.equal(memoFiles.length, 7);
  const sources = new Set<MemoSource>();
  for (const p of memoFiles) {
    const text = await read(p);
    const parsed = parseMemoFile(text);
    assert.ok(parsed.ok, `${p}: ${parsed.ok ? '' : parsed.detail}`);
    assert.equal(renderMemoFile(parsed.value.memo, parsed.value.routing), text, p);
    sources.add(parsed.value.memo.source);
  }
  assert.deepEqual([...sources].sort(), ['agent', 'feed', 'share', 'typed']);

  const photo = parseMemoFile(await read(`일상/raw/${id(5)}.md`));
  assert.ok(photo.ok);
  assert.deepEqual(photo.value.memo.attachments.map((a) => [a.origin, a.location?.from]), [['gallery', 'exif'], ['camera', 'device']]);
  const agent = parseMemoFile(await read(`스터디/raw/${id(4)}.md`));
  assert.ok(agent.ok);
  assert.deepEqual(agent.value.memo.context, { project: 'notes-app', cwd: '/w/notes-app', branch: 'main' });
  const moved = parseMemoFile(await read(`일상/raw/${id(6)}.md`));
  assert.ok(moved.ok);
  assert.deepEqual(moved.value.routing, { by: 'user', from: '스터디', previous: { by: 'hint' } });
  const held = parseMemoFile(await read(`일상/hold/${id(7)}.md`));
  assert.ok(held.ok);
  assert.deepEqual(held.value.routing, { by: 'classifier', confidence: 0.3, reason: '애매함' });
});

test('sidecars and the staged answer parse and render back to their bytes', async () => {
  const sidecars = DOMAINS.flatMap((d) => files(`${d}/raw`)).filter((p) => p.endsWith('.source.md'));
  assert.deepEqual(sidecars, [`스터디/raw/${id(2)}.source.md`, `스터디/raw/${id(3)}.source.md`]);
  for (const p of sidecars) {
    const text = await read(p);
    const parsed = parseSourceFile(text);
    assert.ok(parsed.ok, p);
    assert.equal(renderSourceFile(parsed.value, ko), text, p);
  }
  const share = parseSourceFile(await read(sidecars[0]!));
  assert.ok(share.ok);
  assert.deepEqual(share.value.sources.map((s) => s.status), ['ok', 'failed']);

  const text = await read(`inbox/answers/스터디/${id(9)}.md`);
  const staged = parseAnswerStaging(text);
  assert.ok(staged);
  assert.deepEqual([staged.id, staged.domain, staged.question, staged.cited, staged.sessionId], [id(9), '스터디', '측정은 언제 하지?', [], null]);
  const filing = {
    ...staged, id: staged.id as AnswerId, domain: staged.domain as DomainName,
    cited: staged.cited.map((c) => parsePageRef(c, staged.domain as DomainName, DOMAINS)!),
  };
  assert.equal(renderAnswerStaging(filing), text);
});

test('each log.md folds to the states dotoriwiki showed', async () => {
  const study = parseLedger(await read(paths.log('스터디' as DomainName)));
  const daily = parseLedger(await read(paths.log('일상' as DomainName)));
  const applied = (verdict: string, pages: string[]) => ({ attempts: 0, terminal: { kind: 'applied', verdict, pages, line: 0 }, lastFailure: null });
  assert.deepEqual(study.history('ingest', id(2)), applied('created', ['RAG.md']));
  assert.deepEqual(study.history('ingest', id(3)), applied('created', ['인사이트/2026.md']));
  assert.deepEqual(study.history('ingest', id(4)), applied('unchanged', []));
  assert.deepEqual(study.history('ingest', id(6)), {
    attempts: 2,
    terminal: { kind: 'moved', to: '일상', line: 3 },
    lastFailure: { kind: 'gave-up', attempt: 3, max: 3, reason: 'broken-link 스터디/wiki/a.md: [[없음]] does not resolve' },
  });
  assert.deepEqual(study.history('file-answer', id(8)), applied('saved', ['answers/2026-10-29 RAG에서 알아낸 게 뭐였지.md']));
  assert.equal(study.failedCount(), 0, 'a moved memo is not failed');
  assert.deepEqual(daily.history('ingest', id(5)), applied('created', ['주제/놀이터.md']));
  assert.deepEqual(daily.history('ingest', id(6)), applied('created', ['ME.md']));
});

/** The pages and answers under <d>/wiki/, as paths under wiki/, with their text. */
async function pagesOf(d: DomainName) {
  const under = files(`${d}/wiki`).map((p) => p.slice(`${d}/wiki/`.length)).filter((p) => p.endsWith('.md'));
  const pages = under.filter((p) => roleOf(p) === 'page' || roleOf(p) === 'answer');
  return { under, pages: await Promise.all(pages.map(async (p) => ({ p, text: await read(`${d}/wiki/${p}`) }))) };
}

test('index.md is what renderIndex makes from the pages beside it', async () => {
  const r = await readConfig(fs, { modelProfiles: new Set() });
  assert.ok(r?.ok);
  for (const d of DOMAINS) {
    const { pages } = await pagesOf(d);
    const types: string[] = r.config.domains.get(d)!.pageTypes.map((t) => t.type);
    assert.equal(renderIndex(d, pages.map(({ p, text }) => pageMeta(p, text)), types, ko), await read(paths.index(d)), d);
  }
});

test('the pages dotoriwiki accepted pass check() as if one job had added them all', async () => {
  const r = await readConfig(fs, { modelProfiles: new Set() });
  assert.ok(r?.ok);
  const all = new Map(await Promise.all(DOMAINS.map(async (d) => [d, await pagesOf(d)] as const)));
  const names = new Map(DOMAINS.map((d) => [d as string, namesOf(all.get(d)!.under)]));
  const attachments = new Set(files('_attachments').map((p) => p.slice('_attachments/'.length)));
  assert.equal(attachments.size, 2);
  let checked = 0;
  for (const d of DOMAINS) {
    const { pages } = all.get(d)!;
    const changes: Change[] = pages.map(({ p }) => ({ path: `${d}/wiki/${p}`, status: 'added' }));
    checked += changes.length;
    const problems = check({
      domain: d,
      changes,
      contents: new Map(pages.map(({ p, text }) => [`${d}/wiki/${p}`, text])),
      reviewBefore: null,
      names,
      allowedTypes: new Set([...r.config.domains.get(d)!.pageTypes.map((t) => t.type), 'answer']),
      outsideWrites: [],
      modifiedInputs: [],
      attachments,
    });
    assert.deepEqual(problems, [], d);
  }
  assert.equal(checked, 5);
});
