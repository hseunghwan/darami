/**
 * A chat question's Reader over the committed folder: its scope, its bounded search, and its budget,
 * counted on the node adapter as SAF reads and lists would be.
 */

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pageMeta, renderIndex } from '../../core/pages';
import { textFor } from '../../core/text';
import type { ChatTarget, DomainName } from '../../core/types';
import { nodeFs } from '../../fs/node';
import { chatReader, READS_PER_ASK, SEARCH_READS } from '../workspace';
import { countingFs, presetWiki } from './harness';

const 스터디 = '스터디' as DomainName;
const 일상 = '일상' as DomainName;
const 미루기 = '미루기 아카이빙' as DomainName;
const DECLARED = [일상, 스터디, 미루기];
const 스터디_CHAT: ChatTarget = { kind: 'domain', domain: 스터디 };
const ROOT_CHAT: ChatTarget = { kind: 'root' };

const put = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const page = (summary: string, body: string) => `---\ntype: concept\nsummary: ${summary}\naliases: []\nstatus: active\nsources: []\nupdated: 2026-10-29\n---\n${body}\n`;

/** The ko preset with `n` 스터디 pages, `페이지 k`, and the index.md the engine would write for them. Only the last says 벡터, in its body. */
async function wikiWith(n: number) {
  const root = await presetWiki('ko');
  const metas = [];
  for (let k = 1; k <= n; k++) {
    const text = page(k === 1 ? '청크 크기와 검색' : `메모 ${k}`, k === n ? '벡터 인덱스를 썼다.' : `본문 ${k}`);
    put(root, `스터디/wiki/페이지 ${k}.md`, text);
    metas.push(pageMeta(`페이지 ${k}.md`, text));
  }
  put(root, '스터디/wiki/index.md', renderIndex('스터디', metas, ['concept'], textFor('ko')));
  put(root, '스터디/raw/01JB8ZQ4M3T9X7K2W5R6N8P001.md', 'raw memo');
  put(root, 'inbox/answers/스터디/x.md', 'staged');
  return root;
}

test('a chat reads only its scope, and anything else reads as missing', async () => {
  const root0 = await wikiWith(2);
  const fs = countingFs(nodeFs(root0));
  const r = chatReader({ fs, target: 스터디_CHAT, declared: DECLARED });
  assert.match((await r.read('스터디/wiki/페이지 1.md')).text, /청크 크기와 검색/);
  assert.match((await r.read('CLAUDE.md')).text, /\S/);
  assert.match((await r.read('스터디/CLAUDE.md')).text, /\S/);
  for (const p of ['스터디/raw/01JB8ZQ4M3T9X7K2W5R6N8P001.md', 'inbox/answers/스터디/x.md', '일상/CLAUDE.md', '../x', '스터디/wiki/../raw/01JB8ZQ4M3T9X7K2W5R6N8P001.md', 'wiki/index.md']) {
    assert.match((await r.read(p)).text, /^error: no such file: .*Paths start at the wiki folder, as in 스터디\/wiki\/index\.md\.$/, p);
  }
  assert.equal(fs.calls('readText', (p) => p.includes('/raw/') || p.startsWith('inbox')), 0);
  put(root0, '스터디/wiki/개념/x.md', page('x', 'x'));
  assert.equal((await r.read('스터디/wiki/개념')).text, 'error: 스터디/wiki/개념 is not a file');
  const root = chatReader({ fs, target: ROOT_CHAT, declared: DECLARED });
  assert.match((await root.read('스터디/CLAUDE.md')).text, /^error: no such file/, 'a root chat reads no domain CLAUDE.md');
});

test('list walks only the chat roots, and a folder above them answers the roots', async () => {
  const fs = countingFs(nodeFs(await wikiWith(2)));
  const r = chatReader({ fs, target: 스터디_CHAT, declared: DECLARED });
  assert.equal((await r.list('')).text, ['일상/wiki/', '스터디/wiki/', '미루기 아카이빙/wiki/', '_schema/', 'CLAUDE.md', 'dotoriwiki.yaml', '스터디/CLAUDE.md'].join('\n'));
  assert.equal((await r.list('스터디')).text, ['스터디/wiki/', '스터디/CLAUDE.md'].join('\n'));
  assert.equal(fs.calls('listTree'), 0);
  assert.equal((await r.list('스터디/raw')).text, 'error: no such folder: 스터디/raw');
  assert.equal((await r.list('inbox')).text, 'error: no such folder: inbox');
  assert.deepEqual((await r.list('스터디/wiki')).text.split('\n'), ['스터디/wiki/index.md', '스터디/wiki/log.md', '스터디/wiki/페이지 1.md', '스터디/wiki/페이지 2.md']);
  assert.equal(fs.calls('listTree', (p) => !p.endsWith('/wiki') && p !== '_schema'), 0);
});

test('search reads index.md and at most SEARCH_READS pages, lists nothing, and answers summary hits without a read', async () => {
  const fs = countingFs(nodeFs(await wikiWith(100)));
  const r = chatReader({ fs, target: 스터디_CHAT, declared: DECLARED });
  const deep = await r.search('벡터');
  assert.equal(fs.calls('listTree') + fs.calls('list'), 0);
  assert.equal(fs.calls('readText'), 1 + SEARCH_READS);
  assert.ok(deep.text.endsWith(`[searched ${SEARCH_READS} of 100 pages; open others by their path in wiki/index.md]`), deep.text);
  fs.reset();
  const again = await r.search('벡터');
  assert.equal(fs.calls('readText'), SEARCH_READS, 'index.md and the pages read are cached, so a second search goes further');
  assert.ok(again.text.endsWith(`[searched ${2 * SEARCH_READS} of 100 pages; open others by their path in wiki/index.md]`), again.text);
  const byIndex = await r.search('청크 검색');
  assert.equal(byIndex.text.split('\n').slice(0, 2).join('\n'), '스터디/wiki/페이지 1.md\n  청크 크기와 검색');
});

test('a question reads at most READS_PER_ASK files, and what it read once is not read again', async () => {
  const fs = countingFs(nodeFs(await wikiWith(80)));
  const r = chatReader({ fs, target: ROOT_CHAT, declared: DECLARED });
  for (let k = 1; k <= READS_PER_ASK; k++) assert.doesNotMatch((await r.read(`스터디/wiki/페이지 ${k}.md`)).text, /^error/, `read ${k}`);
  assert.match((await r.read(`스터디/wiki/페이지 ${READS_PER_ASK + 1}.md`)).text, /^error: this question has read 60 files/);
  fs.reset();
  assert.doesNotMatch((await r.read('스터디/wiki/페이지 3.md')).text, /^error/);
  assert.equal(fs.calls('readText'), 0);
  assert.doesNotMatch((await r.search('벡터')).text, /^error/, 'search still answers from index.md');
});

test("the names a question can cite are its domains' index entries and the pages it read", async () => {
  const root = await wikiWith(2);
  put(root, '스터디/wiki/손으로 쓴.md', page('Obsidian에서', '본문'));
  const r = chatReader({ fs: countingFs(nodeFs(root)), target: 스터디_CHAT, declared: DECLARED });
  await r.read('스터디/wiki/손으로 쓴.md');
  await r.read('스터디/wiki/없음.md');
  const names = await r.pageNames([스터디, 일상]);
  assert.deepEqual([...names.get(스터디)!].sort(), ['index', '손으로 쓴', '페이지 1', '페이지 2'].sort(), 'index.md counts as check() counts it');
  assert.deepEqual([...names.get(일상)!], []);
});

test('a reader has no method that writes', async () => {
  const r = chatReader({ fs: nodeFs(await wikiWith(1)), target: 스터디_CHAT, declared: DECLARED });
  // @ts-expect-error a chat Reader has no write
  assert.equal(r.write, undefined);
  assert.deepEqual(Object.keys(r).sort(), ['list', 'pageNames', 'read', 'search']);
});
