import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WikiPath } from '../../core/layout';
import { nodeFs } from '../node';

const at = (s: string) => s as WikiPath;

function folder() {
  const root = mkdtempSync(join(tmpdir(), 'darami-nodefs-'));
  mkdirSync(join(root, '스터디', 'wiki'), { recursive: true });
  return { root, fs: nodeFs(root) };
}

test('text comes back exactly as stored: BOM, CRLF, and Hangul kept', async () => {
  const { root, fs } = folder();
  const text = '﻿---\r\ntype: concept\r\n---\r\n도토리 🌰\r\n';
  writeFileSync(join(root, '스터디', 'wiki', '도토리.md'), Buffer.from(text, 'utf8'));
  assert.equal(await fs.readText(at('스터디/wiki/도토리.md')), text);
});

test('absence is null: a missing file, a missing parent, a parent that is a file', async () => {
  const { root, fs } = folder();
  writeFileSync(join(root, 'CLAUDE.md'), '# root\n');
  assert.equal(await fs.readText(at('스터디/CLAUDE.md')), null);
  assert.equal(await fs.readText(at('없는 도메인/wiki/log.md')), null);
  assert.equal(await fs.readText(at('CLAUDE.md/x.md')), null);
});

test('a folder where a file was expected throws, and so does a path that breaks the rule', async () => {
  const { fs } = folder();
  await assert.rejects(fs.readText(at('스터디')), /EISDIR/);
  await assert.rejects(fs.readText(at('')), /EISDIR/);
  for (const bad of ['../x', '/x', 'a//b', 'a/', 'a\\b', './a', '스터디'.normalize('NFD')]) {
    await assert.rejects(fs.readText(at(bad)), /not a wiki path/, JSON.stringify(bad));
  }
});
