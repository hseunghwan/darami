import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { nodeFs } from '../../fs/node';
import type { Fs } from '../fs';
import { presetFiles } from '../presets';
import { inspectFolder, setUpWiki, type FolderState } from '../wiki';

const PRESETS = join(__dirname, '..', '..', '..', 'presets');
const MADE = join(__dirname, 'fixtures', 'made-by-dotoriwiki');
const machine = { modelProfiles: new Set<string>() };
const setUp = { locale: 'ko', zone: 'GMT', machine } as const;
const KO_DOMAINS = ['일상', '스터디', '미루기 아카이빙'];

const temp = () => mkdtempSync(join(tmpdir(), 'darami-folder-'));

/** Every file under `root` as `path: text`, sorted, NFC paths. */
function snapshot(root: string): string[] {
  return [...readdirSync(root, { recursive: true, withFileTypes: true })]
    .filter((e) => e.isFile())
    .map((e) => {
      const full = join(e.parentPath, e.name);
      return `${relative(root, full).split(sep).join('/').normalize('NFC')}: ${JSON.stringify(readFileSync(full, 'utf8'))}`;
    })
    .sort();
}

/** presets/ko as setUpWiki should leave it on the emulator: the dot restored and the zone set. */
function expectedKo(): string[] {
  const root = temp();
  cpSync(join(PRESETS, 'ko'), root, { recursive: true });
  cpSync(join(root, 'gitignore'), join(root, '.gitignore'));
  rmSync(join(root, 'gitignore'));
  const config = join(root, 'dotoriwiki.yaml');
  writeFileSync(config, readFileSync(config, 'utf8').replace('time_zone: Asia/Seoul', 'time_zone: GMT'));
  return snapshot(root);
}

const domainsOf = (s: FolderState) => (s.kind === 'wiki' ? [...s.config.domains.keys()] : s.kind);

/** An Fs whose create dies once `k` creates have finished: before touching the file, or after making it empty. */
function dyingAfter(fs: Fs, k: number, leave: 'nothing' | 'empty'): Fs {
  let made = 0;
  return {
    ...fs,
    async create(path, text) {
      if (made === k) {
        if (leave === 'empty') await fs.create(path, '');
        throw new Error('killed');
      }
      made++;
      return fs.create(path, text);
    },
  };
}

test('a folder with nothing, or only dot names, is empty', async () => {
  const root = temp();
  assert.deepEqual(await inspectFolder(nodeFs(root), machine, 'ko'), { kind: 'empty' });
  mkdirSync(join(root, '.stfolder'));
  mkdirSync(join(root, '.obsidian'));
  mkdirSync(join(root, '.trash'));
  writeFileSync(join(root, '.gitignore'), 'x\n');
  assert.deepEqual(await inspectFolder(nodeFs(root), machine, 'ko'), { kind: 'empty' });
});

test('setUpWiki writes the ko preset byte for byte, with .gitignore and the zone, and answers its domains', async () => {
  const root = temp();
  mkdirSync(join(root, '.stfolder'));
  const state = await setUpWiki(nodeFs(root), setUp);
  assert.deepEqual(domainsOf(state), KO_DOMAINS);
  assert.ok(state.kind === 'wiki');
  assert.deepEqual(state.warnings, []);
  assert.deepEqual(snapshot(root), expectedKo());
});

test('a second setUpWiki writes nothing and answers the same state', async () => {
  const root = temp();
  const fs = nodeFs(root);
  await setUpWiki(fs, setUp);
  const answers: string[] = [];
  const watched: Fs = { ...fs, create: async (p, t) => { const a = await fs.create(p, t); answers.push(a); return a; } };
  const state = await setUpWiki(watched, setUp);
  assert.deepEqual(domainsOf(state), KO_DOMAINS);
  assert.deepEqual(answers, [], 'a wiki is not written to');
  assert.deepEqual(snapshot(root), expectedKo());
});

test('a copy killed after any number of files, or between making a file and writing it, reads unfinished and finishes to the same bytes', async () => {
  const total = presetFiles('ko', 'GMT').length;
  for (const leave of ['nothing', 'empty'] as const) {
    for (let k = 0; k < total; k++) {
      const root = temp();
      await assert.rejects(setUpWiki(dyingAfter(nodeFs(root), k, leave), setUp), /killed/);
      const cut = await inspectFolder(nodeFs(root), machine, 'ko');
      // Only .gitignore, written first, can be there with nothing visible.
      const expected = snapshot(root).every((l) => l.startsWith('.gitignore:')) ? { kind: 'empty' } : { kind: 'unfinished', locale: 'ko' };
      assert.deepEqual(cut, expected, `${leave} after ${k}`);
      const state = await setUpWiki(nodeFs(root), setUp);
      assert.deepEqual(domainsOf(state), KO_DOMAINS, `${leave} after ${k}`);
      assert.deepEqual(snapshot(root), expectedKo(), `${leave} after ${k}`);
    }
  }
});

test('finishing a cut-off copy keeps its locale and a file the user changed meanwhile', async () => {
  const root = temp();
  await assert.rejects(setUpWiki(dyingAfter(nodeFs(root), 5, 'nothing'), setUp), /killed/);
  writeFileSync(join(root, 'CLAUDE.md'), '# 내 위키\n');
  assert.deepEqual(domainsOf(await setUpWiki(nodeFs(root), { ...setUp, locale: 'en' })), KO_DOMAINS);
  assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), '# 내 위키\n');
});

test('a wiki dotoriwiki made reads as a wiki with its domains and one warning, and inspecting writes nothing', async () => {
  const root = temp();
  cpSync(MADE, root, { recursive: true });
  const before = snapshot(root);
  const state = await inspectFolder(nodeFs(root), machine, 'ko');
  assert.deepEqual(domainsOf(state), KO_DOMAINS);
  assert.ok(state.kind === 'wiki');
  assert.deepEqual(state.warnings.map((w) => w.key), ['domains.스터디.model_profile']);
  assert.equal((await setUpWiki(nodeFs(root), setUp)).kind, 'wiki');
  assert.deepEqual(snapshot(root), before);
});

test('a config that does not parse, or a missing CLAUDE.md, reads as broken with its problems', async () => {
  const yaml = temp();
  cpSync(join(PRESETS, 'ko'), yaml, { recursive: true });
  writeFileSync(join(yaml, 'dotoriwiki.yaml'), 'version: 1\nlocale: [ko\n');
  const bad = await inspectFolder(nodeFs(yaml), machine, 'ko');
  assert.deepEqual(bad.kind === 'broken' && bad.problems.map((p) => p.key), ['dotoriwiki.yaml']);
  const schema = temp();
  cpSync(join(PRESETS, 'ko'), schema, { recursive: true });
  rmSync(join(schema, '스터디', 'CLAUDE.md'));
  const before = snapshot(schema);
  const missing = await setUpWiki(nodeFs(schema), setUp);
  assert.deepEqual(missing.kind === 'broken' && missing.problems.map((p) => p.key), ['domains.스터디']);
  assert.deepEqual(snapshot(schema), before, 'a broken wiki is not written to');
});

test('a folder of other files reads as foreign, showing at most three names, and is not written to', async () => {
  const root = temp();
  for (const n of ['notes.md', 'photos', 'b.txt', 'a.txt']) writeFileSync(join(root, n), 'x');
  writeFileSync(join(root, '.nomedia'), '');
  const state = await setUpWiki(nodeFs(root), setUp);
  assert.deepEqual(state, { kind: 'foreign', names: ['a.txt', 'b.txt', 'notes.md'] });
  assert.deepEqual(snapshot(root), ['.nomedia: ""', 'a.txt: "x"', 'b.txt: "x"', 'notes.md: "x"', 'photos: "x"']);
});

test('a folder that is gone reads as unreachable, and setUpWiki makes nothing', async () => {
  const root = join(temp(), 'wiki');
  assert.deepEqual(await inspectFolder(nodeFs(root), machine, 'ko'), { kind: 'unreachable' });
  assert.deepEqual(await setUpWiki(nodeFs(root), setUp), { kind: 'unreachable' });
  assert.deepEqual([...readdirSync(join(root, '..'))], []);
});
