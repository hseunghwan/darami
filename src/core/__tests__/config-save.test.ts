import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeFs } from '../../fs/node';
import { draftOf, type ConfigEdit, type DomainDraft } from '../config-edit';
import type { Fs } from '../fs';
import { paths } from '../layout';
import type { DomainName } from '../types';
import { composeSystemPrompt, inspectFolder, readConfig, saveConfigEdit, type FolderState } from '../wiki';
import { memoryIntent } from './helpers';

const PRESETS = join(__dirname, '..', '..', '..', 'presets');
const machine = { modelProfiles: new Set<string>() };
const 스터디 = '스터디' as DomainName;
const RECIPES: DomainDraft = { description: '해 본 요리', pageTypes: [{ type: 'recipe', description: '요리 하나', example: '김치찌개.md' }] };

function koWiki(): string {
  const root = mkdtempSync(join(tmpdir(), 'darami-save-'));
  cpSync(join(PRESETS, 'ko'), root, { recursive: true });
  return root;
}

/** Every file under `root` with its bytes, so a test sees that nothing was written. */
const snapshot = (root: string) =>
  readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => `${join(e.parentPath, e.name)}: ${readFileSync(join(e.parentPath, e.name), 'latin1')}`)
    .sort();

async function studyEdit(root: string, description: string): Promise<ConfigEdit> {
  const r = await readConfig(nodeFs(root), machine);
  assert.ok(r?.ok);
  const seen = draftOf(r.config.domains.get(스터디)!);
  return { kind: 'domain', name: 스터디, seen, want: { ...seen, description } };
}

const configText = (root: string) => readFileSync(join(root, 'dotoriwiki.yaml'), 'utf8');
const descriptionIn = (s: FolderState) => (s.kind === 'wiki' ? s.config.domains.get(스터디)?.description : s.kind);

/** The node adapter, killed inside the n-th write of dotoriwiki.yaml after `bytes` of it are on disk. */
function killedInConfigWrite(root: string, bytes: (whole: Uint8Array) => number): Fs {
  const fs = nodeFs(root);
  return {
    ...fs,
    async write(path, text) {
      if (path !== paths.config) return fs.write(path, text);
      const whole = new TextEncoder().encode(text);
      writeFileSync(join(root, path), whole.subarray(0, bytes(whole)));
      throw new Error('killed');
    },
  };
}

test('a saved edit reads back from the folder, and the intent is gone', async () => {
  const root = koWiki();
  const intent = memoryIntent();
  const edit = await studyEdit(root, '직접 해본 것');
  const r = await saveConfigEdit(nodeFs(root), intent, machine, edit);
  assert.equal(r.kind, 'saved');
  assert.equal(configText(root), readFileSync(join(PRESETS, 'ko', 'dotoriwiki.yaml'), 'utf8').replace('일에서든 혼자서든 내가 직접 해보고 배운 것', '직접 해본 것'));
  assert.equal(descriptionIn(await inspectFolder(nodeFs(root), machine, 'ko', intent)), '직접 해본 것');
  assert.equal(intent.held(), null);
  assert.equal((await saveConfigEdit(nodeFs(root), intent, machine, edit)).kind, 'same', 'a second Save');
});

test('a refused edit, or one into a broken folder, writes nothing', async () => {
  const root = koWiki();
  const edit = await studyEdit(root, '직접 해본 것');
  writeFileSync(join(root, 'dotoriwiki.yaml'), configText(root).replace('일에서든', '회사에서든'));
  const before = snapshot(root);
  const r = await saveConfigEdit(nodeFs(root), memoryIntent(), machine, edit);
  assert.deepEqual(r.kind === 'refused' && r.refusal, { kind: 'moved-on' });
  assert.deepEqual(snapshot(root), before);

  const missing = koWiki();
  const fresh = await studyEdit(missing, '직접 해본 것');
  await nodeFs(missing).remove(paths.domainSchema('일상' as DomainName));
  const gone = snapshot(missing);
  const broken = await saveConfigEdit(nodeFs(missing), memoryIntent(), machine, fresh);
  assert.deepEqual(broken.kind === 'refused' && broken.refusal.kind === 'broken' && broken.refusal.problems.map((p) => p.key), ['domains.일상']);
  assert.deepEqual(snapshot(missing), gone);
});

test('an added domain gets a CLAUDE.md that pulls in the common rules, so the wiki reads with it', async () => {
  const root = koWiki();
  const r = await saveConfigEdit(nodeFs(root), memoryIntent(), machine, { kind: 'add', name: '요리', want: RECIPES });
  assert.equal(r.kind, 'saved');
  const read = await readConfig(nodeFs(root), machine);
  assert.ok(read?.ok);
  assert.deepEqual([...read.config.domains.keys()], ['일상', '스터디', '미루기 아카이빙', '요리']);
  const prompt = await composeSystemPrompt(nodeFs(root), paths.domainSchema('요리' as DomainName));
  const common = readFileSync(join(PRESETS, 'ko', '_schema', '공통규칙.md'), 'utf8').trimEnd();
  assert.equal(prompt, `# 요리\n\n${common}\n\n## 목적\n\n해 본 요리\n`);
});

test('an added name that is already a folder adopts it and keeps its CLAUDE.md', async () => {
  const root = koWiki();
  mkdirSync(join(root, '요리', 'wiki'), { recursive: true });
  writeFileSync(join(root, '요리', 'CLAUDE.md'), '# 요리\n\n내가 쓴 설명.\n');
  assert.equal((await saveConfigEdit(nodeFs(root), memoryIntent(), machine, { kind: 'add', name: '요리', want: RECIPES })).kind, 'saved');
  assert.equal(readFileSync(join(root, '요리', 'CLAUDE.md'), 'utf8'), '# 요리\n\n내가 쓴 설명.\n');

  writeFileSync(join(root, '메모.md'), 'x');
  const file = await saveConfigEdit(nodeFs(root), memoryIntent(), machine, { kind: 'add', name: '메모.md', want: RECIPES });
  assert.deepEqual(file.kind === 'refused' && file.refusal, { kind: 'taken', holder: '메모.md', by: 'file' });
});

test('a CLAUDE.md a kill cut off part way, even inside a character, is finished when the add is saved again', async () => {
  const root = koWiki();
  const fs = nodeFs(root);
  const dying: Fs = {
    ...fs,
    async create(path, text) {
      const whole = new TextEncoder().encode(text);
      mkdirSync(join(root, '요리'), { recursive: true });
      writeFileSync(join(root, path), whole.subarray(0, whole.findIndex((b) => b >= 0x80) + 1));
      throw new Error('killed');
    },
  };
  const add: ConfigEdit = { kind: 'add', name: '요리', want: RECIPES };
  await assert.rejects(saveConfigEdit(dying, memoryIntent(), machine, add), /killed/);
  assert.equal(readFileSync(join(root, '요리', 'CLAUDE.md')).toString('hex'), '2320ec', 'the file ends inside 요');
  assert.equal(descriptionIn(await inspectFolder(fs, machine, 'ko', memoryIntent())), '일에서든 혼자서든 내가 직접 해보고 배운 것', 'the wiki still reads, without the new domain');
  assert.equal((await saveConfigEdit(fs, memoryIntent(), machine, add)).kind, 'saved');
  assert.equal(readFileSync(join(root, '요리', 'CLAUDE.md'), 'utf8'), '# 요리\n\n@../_schema/공통규칙.md\n\n## 목적\n\n해 본 요리\n');
});

test('an edit killed inside the yaml write is finished by the next inspect, wherever the bytes were cut', async () => {
  const clean = koWiki();
  await saveConfigEdit(nodeFs(clean), memoryIntent(), machine, await studyEdit(clean, '직접 해본 것'));
  const intended = readFileSync(join(clean, 'dotoriwiki.yaml'));
  const insideHangul = intended.indexOf(Buffer.from('직접')) + 1;
  for (const cut of [0, 1, insideHangul, Math.floor(intended.length / 2), intended.length - 1]) {
    const root = koWiki();
    const intent = memoryIntent();
    await assert.rejects(saveConfigEdit(killedInConfigWrite(root, () => cut), intent, machine, await studyEdit(root, '직접 해본 것')), /killed/);
    assert.equal(readFileSync(join(root, 'dotoriwiki.yaml')).length, cut, `cut at ${cut}: the file is cut short`);
    const state = await inspectFolder(nodeFs(root), machine, 'ko', intent);
    assert.equal(descriptionIn(state), '직접 해본 것', `cut at ${cut}`);
    assert.ok(readFileSync(join(root, 'dotoriwiki.yaml')).equals(intended), `cut at ${cut}: the bytes an uncut save writes`);
    assert.equal(intent.held(), null, `cut at ${cut}`);
  }
});

test('a kill before the yaml write keeps the old file, one after it keeps the new, and a file another app wrote meanwhile is kept', async () => {
  const before = koWiki();
  const old = configText(before);
  const notWritten = memoryIntent();
  const fs = nodeFs(before);
  await assert.rejects(
    saveConfigEdit({ ...fs, write: async () => Promise.reject(new Error('killed')) }, notWritten, machine, await studyEdit(before, '직접 해본 것')),
    /killed/,
  );
  assert.equal(descriptionIn(await inspectFolder(fs, machine, 'ko', notWritten)), '일에서든 혼자서든 내가 직접 해보고 배운 것');
  assert.equal(configText(before), old);
  assert.equal(notWritten.held(), null);

  const after = koWiki();
  const written = memoryIntent();
  await assert.rejects(saveConfigEdit(nodeFs(after), { ...written, clear: () => Promise.reject(new Error('killed')) }, machine, await studyEdit(after, '직접 해본 것')), /killed/);
  assert.equal(descriptionIn(await inspectFolder(nodeFs(after), machine, 'ko', written)), '직접 해본 것');
  assert.equal(written.held(), null);

  const theirs = koWiki();
  const cutOff = memoryIntent();
  await assert.rejects(saveConfigEdit(killedInConfigWrite(theirs, (w) => w.length >> 1), cutOff, machine, await studyEdit(theirs, '직접 해본 것')), /killed/);
  writeFileSync(join(theirs, 'dotoriwiki.yaml'), old.replace('일에서든 혼자서든', 'Obsidian에서 고친'));
  assert.equal(descriptionIn(await inspectFolder(nodeFs(theirs), machine, 'ko', cutOff)), 'Obsidian에서 고친 내가 직접 해보고 배운 것');
  assert.equal(cutOff.held(), null);
});
