/**
 * The Fs port's contract (core/fs.ts) as cases every adapter runs: node.test.ts under jest, and
 * darami://fs-check (src/app/fs-check.tsx) on SAF on a device. One list, so the adapters cannot
 * drift apart silently.
 *
 * This file ships in the app bundle and runs on Hermes, so it imports no node:* and no jest.
 *
 * Each case gets an Fs bound to a fresh empty folder and a Seed that writes into that folder around
 * the port, for what the port cannot make: an NFD name, a dot folder, an empty file, a gone root.
 */

import { FolderUnreachable, type Fs } from '../core/fs';
import { ROOT, type WikiPath } from '../core/layout';

/** Raw writes into the case's folder, bypassing the port. `rel` is `/`-separated and may be NFD. */
export type Seed = {
  file(rel: string, text: string): Promise<void>;
  folder(rel: string): Promise<void>;
  /** Deletes the case's folder itself, so the Fs is bound to nothing. */
  dropRoot(): Promise<void>;
};

export type FsCase = { readonly name: string; readonly run: (fs: Fs, seed: Seed) => Promise<void> };

export const at = (s: string) => s as WikiPath;

export function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: got ${a}, want ${b}`);
}

export async function throws(p: Promise<unknown>, ok: (e: unknown) => boolean, what: string): Promise<void> {
  try {
    await p;
  } catch (e) {
    if (ok(e)) return;
    throw new Error(`${what}: threw the wrong error: ${String(e)}`);
  }
  throw new Error(`${what}: did not throw`);
}

const unreachable = (e: unknown) => e instanceof FolderUnreachable;
// Not `instanceof Error`: node:fs rejects with errors from another realm under jest.
const otherError = (e: unknown) => e != null && !(e instanceof FolderUnreachable);
const badPath = (e: unknown) => /not a wiki path/.test(String((e as { message?: unknown } | null)?.message));

export const FS_CASES: readonly FsCase[] = [
  {
    name: 'readText: the text comes back exactly as stored, a BOM, CRLF, and Hangul kept',
    run: async (fs, seed) => {
      const text = '﻿---\r\ntype: concept\r\n---\r\n도토리 🌰\r\n';
      await seed.file('스터디/wiki/도토리.md', text);
      same(await fs.readText(at('스터디/wiki/도토리.md')), text, 'text');
    },
  },
  {
    name: 'readText: null for a missing file, a missing parent, and a parent that is a file',
    run: async (fs, seed) => {
      await seed.file('CLAUDE.md', '# root\n');
      await seed.folder('스터디');
      same(await fs.readText(at('스터디/CLAUDE.md')), null, 'missing file');
      same(await fs.readText(at('없는 도메인/wiki/log.md')), null, 'missing parent');
      same(await fs.readText(at('CLAUDE.md/x.md')), null, 'parent is a file');
    },
  },
  {
    name: 'readText: a folder throws, the root included',
    run: async (fs, seed) => {
      await seed.folder('스터디/wiki');
      await throws(fs.readText(at('스터디')), otherError, 'a folder');
      await throws(fs.readText(ROOT), otherError, 'the root');
    },
  },
  {
    name: 'every method refuses a path that breaks the WikiPath rule, and create refuses the root',
    run: async (fs) => {
      for (const bad of ['../x', '/x', 'a//b', 'a/', 'a\\b', './a', '스터디'.normalize('NFD')]) {
        await throws(fs.readText(at(bad)), badPath, `readText ${JSON.stringify(bad)}`);
        await throws(fs.list(at(bad)), badPath, `list ${JSON.stringify(bad)}`);
        await throws(fs.create(at(bad), 'x'), badPath, `create ${JSON.stringify(bad)}`);
      }
      await throws(fs.create(ROOT, 'x'), otherError, 'create the root');
    },
  },
  {
    name: 'list: names are distinct and sorted by code unit, files and folders alike, dot names kept',
    run: async (fs, seed) => {
      await seed.folder('.stfolder');
      await seed.file('.obsidian/app.json', '{}');
      await seed.file('b.md', 'b');
      await seed.file('A.md', 'a');
      await seed.folder('스터디');
      await seed.file('inbox/.gitkeep', '');
      same(await fs.list(ROOT), ['.obsidian', '.stfolder', 'A.md', 'b.md', 'inbox', '스터디'], 'root');
      same(await fs.list(at('inbox')), ['.gitkeep'], 'inbox');
      same(await fs.list(at('스터디')), [], 'an empty folder');
    },
  },
  {
    name: 'list: a name stored as NFD comes back as NFC',
    run: async (fs, seed) => {
      await seed.folder('미루기 아카이빙'.normalize('NFD'));
      await seed.file('도토리.md'.normalize('NFD'), 'x');
      same(await fs.list(ROOT), ['도토리.md', '미루기 아카이빙'], 'NFC names');
    },
  },
  {
    name: 'list: [] for a missing folder, and a file throws',
    run: async (fs, seed) => {
      await seed.file('CLAUDE.md', '# root\n');
      same(await fs.list(at('없음')), [], 'missing');
      same(await fs.list(at('없음/더 깊이')), [], 'missing parent');
      await throws(fs.list(at('CLAUDE.md')), otherError, 'a file');
    },
  },
  {
    name: 'create: makes the parent folders, answers created, and the text reads back whole',
    run: async (fs) => {
      const long = `${'도토리 한 알, acorn one. '.repeat(4000)}\n`;
      same(await fs.create(at('미루기 아카이빙/wiki/answers/긴 답.md'), long), 'created', 'deep create');
      same(await fs.readText(at('미루기 아카이빙/wiki/answers/긴 답.md')), long, 'long text');
      same(await fs.create(at('CLAUDE.md'), '# root\n'), 'created', 'root file');
      same(await fs.readText(at('CLAUDE.md')), '# root\n', 'root text');
      same(await fs.list(at('미루기 아카이빙/wiki')), ['answers'], 'made folders');
    },
  },
  {
    name: 'create: a second create answers exists, keeps the first text, and leaves no renamed twin',
    run: async (fs) => {
      same(await fs.create(at('inbox/a.md'), 'first\n'), 'created', 'first');
      same(await fs.create(at('inbox/a.md'), 'second, longer\n'), 'exists', 'second');
      same(await fs.readText(at('inbox/a.md')), 'first\n', 'kept');
      same(await fs.list(at('inbox')), ['a.md'], 'no twin');
      same(await fs.list(ROOT), ['inbox'], 'no folder twin');
    },
  },
  {
    name: 'create: an empty file is filled and answered created',
    run: async (fs, seed) => {
      await seed.file('스터디/CLAUDE.md', '');
      same(await fs.create(at('스터디/CLAUDE.md'), '# 스터디\n'), 'created', 'filled');
      same(await fs.readText(at('스터디/CLAUDE.md')), '# 스터디\n', 'text');
      same(await fs.list(at('스터디')), ['CLAUDE.md'], 'no twin');
    },
  },
  {
    name: "create: '' makes an empty file, and a file with bytes is never emptied",
    run: async (fs, seed) => {
      same(await fs.create(at('inbox/.gitkeep'), ''), 'created', 'empty');
      same(await fs.readText(at('inbox/.gitkeep')), '', 'empty text');
      same(await fs.create(at('inbox/.gitkeep'), ''), 'exists', 'nothing to fill');
      await seed.file('raw/.gitkeep', 'kept');
      same(await fs.create(at('raw/.gitkeep'), ''), 'exists', 'has bytes');
      same(await fs.readText(at('raw/.gitkeep')), 'kept', 'kept');
    },
  },
  {
    name: 'create: names land exactly as asked, with nothing added',
    run: async (fs) => {
      for (const name of ['dotoriwiki.yaml', '.gitignore', '.gitkeep', 'noext', 'a.md', '미루기 아카이빙.md']) {
        same(await fs.create(at(name), 'x'), 'created', name);
      }
      same(await fs.list(ROOT), ['.gitignore', '.gitkeep', 'a.md', 'dotoriwiki.yaml', 'noext', '미루기 아카이빙.md'], 'names');
    },
  },
  {
    name: 'create: a folder at the path throws, and the folder keeps what it holds',
    run: async (fs, seed) => {
      await seed.file('스터디/CLAUDE.md', '# 스터디\n');
      await throws(fs.create(at('스터디'), 'x'), otherError, 'a folder');
      same(await fs.list(at('스터디')), ['CLAUDE.md'], 'contents');
      same(await fs.list(ROOT), ['스터디'], 'no twin');
    },
  },
  {
    name: 'create: a file where a parent folder belongs throws',
    run: async (fs, seed) => {
      await seed.file('CLAUDE.md', '# root\n');
      await throws(fs.create(at('CLAUDE.md/x.md'), 'x'), otherError, 'a file in the way');
      same(await fs.readText(at('CLAUDE.md')), '# root\n', 'the file kept');
      same(await fs.list(ROOT), ['CLAUDE.md'], 'no twin');
    },
  },
  {
    name: 'FolderUnreachable: once the folder is gone, every method throws it, and create makes nothing',
    run: async (fs, seed) => {
      await seed.file('CLAUDE.md', '# root\n');
      await seed.dropRoot();
      await throws(fs.readText(at('CLAUDE.md')), unreachable, 'readText');
      await throws(fs.list(ROOT), unreachable, 'list');
      await throws(fs.list(at('스터디')), unreachable, 'list under');
      await throws(fs.create(at('스터디/CLAUDE.md'), 'x'), unreachable, 'create');
      await throws(fs.list(ROOT), unreachable, 'still gone after create');
    },
  },
];
