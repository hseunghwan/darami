import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeFs } from '../../fs/node';
import type { ConfigParse } from '../config';
import { paths, type WikiPath } from '../layout';
import type { DomainName } from '../types';
import { composeSystemPrompt, readConfig } from '../wiki';

const PRESETS = join(__dirname, '..', '..', '..', 'presets');
const MIGRATED = join(__dirname, 'fixtures', 'migrated-wiki');
const machine = { modelProfiles: new Set<string>() };
const keys = (r: ConfigParse | null) => (r === null ? null : r.ok ? [] : r.problems.map((p) => p.key));
const at = (s: string) => s as WikiPath;

/** A temp copy of a wiki folder, to break on purpose. */
function scratch(from: string): string {
  const root = mkdtempSync(join(tmpdir(), 'darami-wiki-'));
  cpSync(from, root, { recursive: true });
  return root;
}

test('both presets read with no problems and no warnings', async () => {
  for (const [l, domains] of [['ko', ['일상', '스터디', '미루기 아카이빙']], ['en', ['journal', 'learning', 'someday']]] as const) {
    const r = await readConfig(nodeFs(join(PRESETS, l)), machine);
    assert.ok(r?.ok, l);
    assert.deepEqual(r.warnings, [], l);
    assert.deepEqual([...r.config.domains.keys()], domains, l);
  }
});

test('a wiki dotoriwiki migrated opens with its domains in written order', async () => {
  const r = await readConfig(nodeFs(MIGRATED), machine);
  assert.ok(r?.ok);
  assert.deepEqual([...r.config.domains.keys()], ['일상', '스터디', '미루기 아카이빙']);
});

test('a missing CLAUDE.md pauses the wiki under its own key', async () => {
  const domain = scratch(join(PRESETS, 'ko'));
  rmSync(join(domain, '스터디', 'CLAUDE.md'));
  assert.deepEqual(keys(await readConfig(nodeFs(domain), machine)), ['domains.스터디']);
  const root = scratch(join(PRESETS, 'ko'));
  rmSync(join(root, 'CLAUDE.md'));
  assert.deepEqual(keys(await readConfig(nodeFs(root), machine)), ['CLAUDE.md']);
});

test('a dotoriwiki.yaml that does not parse reports its own problems first', async () => {
  const root = scratch(join(PRESETS, 'ko'));
  writeFileSync(join(root, 'dotoriwiki.yaml'), 'version: 1\nlocale: [ko\n');
  rmSync(join(root, '스터디', 'CLAUDE.md'));
  assert.deepEqual(keys(await readConfig(nodeFs(root), machine)), ['dotoriwiki.yaml']);
});

test('a folder with no dotoriwiki.yaml is not a wiki', async () => {
  assert.equal(await readConfig(nodeFs(mkdtempSync(join(tmpdir(), 'darami-empty-'))), machine), null);
});

test('a domain prompt inlines its @ import from the preset', async () => {
  const ko = join(PRESETS, 'ko');
  const own = readFileSync(join(ko, '스터디', 'CLAUDE.md'), 'utf8');
  const common = readFileSync(join(ko, '_schema', '공통규칙.md'), 'utf8');
  assert.ok(own.includes('\n@../_schema/공통규칙.md\n'));
  assert.equal(await composeSystemPrompt(nodeFs(ko), paths.domainSchema('스터디' as DomainName)), own.replace('@../_schema/공통규칙.md', common.trimEnd()));
});

test('an import cycle stops where a file would inline itself again', async () => {
  const root = mkdtempSync(join(tmpdir(), 'darami-cycle-'));
  writeFileSync(join(root, 'CLAUDE.md'), 'top\n@x.md\n');
  writeFileSync(join(root, 'x.md'), 'x\n@CLAUDE.md\n');
  assert.equal(await composeSystemPrompt(nodeFs(root), paths.rootSchema), 'top\nx\n@CLAUDE.md\n');
  writeFileSync(join(root, 'CLAUDE.md'), 'a\n@CLAUDE.md\n');
  assert.equal(await composeSystemPrompt(nodeFs(root), paths.rootSchema), 'a\na\n@CLAUDE.md\n', 'a self-import is inlined once');
});

test('an import that is missing or leaves the folder keeps its line as written', async () => {
  const own = readFileSync(join(MIGRATED, '스터디', 'CLAUDE.md'), 'utf8');
  assert.equal(await composeSystemPrompt(nodeFs(MIGRATED), paths.domainSchema('스터디' as DomainName)), own, 'the migrated wiki has no _schema/');
  const root = mkdtempSync(join(tmpdir(), 'darami-escape-'));
  cpSync(MIGRATED, join(root, 'wiki'), { recursive: true });
  writeFileSync(join(root, 'outside.md'), 'OUT\n');
  writeFileSync(join(root, 'wiki', 'CLAUDE.md'), '# root\n@../outside.md\n@/etc/hosts\n');
  assert.equal(await composeSystemPrompt(nodeFs(join(root, 'wiki')), paths.rootSchema), '# root\n@../outside.md\n@/etc/hosts\n');
  await assert.rejects(composeSystemPrompt(nodeFs(root), at('없음.md')), /없음\.md does not exist/);
});
