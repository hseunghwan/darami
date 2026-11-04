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
  bytes(rel: string, bytes: Uint8Array): Promise<void>;
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

/** Compared as hex: JSON of a Uint8Array would not show a missing or extra byte at the end. */
export const hex = (b: Uint8Array | null) => (b === null ? null : Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''));
const sameBytes = (actual: Uint8Array | null, expected: Uint8Array | null, what: string) => {
  if (hex(actual) !== hex(expected)) throw new Error(`${what}: got ${actual === null ? 'null' : `${actual.length} bytes`} that differ from the ${expected === null ? 'null' : `${expected.length} bytes`} wanted`);
};
/** Every byte value, an invalid UTF-8 run, CRLF, and a BOM: what a text path would mangle. */
const EVERY_BYTE = Uint8Array.from([...Array.from({ length: 256 }, (_, i) => i), 0xc3, 0x28, 0xa0, 0xa1, 0x0d, 0x0a, 0xef, 0xbb, 0xbf, 0xff, 0xd9]);
const big = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + (i >> 8)) & 0xff);

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
  {
    name: 'write: makes the file and its parent folders, and a long Hangul text reads back whole',
    run: async (fs) => {
      const long = `${'도토리 한 알, acorn one. '.repeat(4000)}\n`;
      await fs.write(at('스터디/wiki/주제/긴 글.md'), long);
      same(await fs.readText(at('스터디/wiki/주제/긴 글.md')), long, 'long text');
      same(await fs.list(at('스터디/wiki')), ['주제'], 'made folders');
    },
  },
  {
    name: 'write: a shorter text over a longer one leaves only the shorter text',
    run: async (fs, seed) => {
      await seed.file('스터디/wiki/log.md', 'AAAAAAAAAA\n');
      await fs.write(at('스터디/wiki/log.md'), 'B\n');
      same(await fs.readText(at('스터디/wiki/log.md')), 'B\n', 'truncated');
      await fs.write(at('스터디/wiki/log.md'), '# log\n## [2026-10-29] ingest | A | 새 페이지 | RAG.md\n');
      same(await fs.readText(at('스터디/wiki/log.md')), '# log\n## [2026-10-29] ingest | A | 새 페이지 | RAG.md\n', 'longer again');
    },
  },
  {
    name: "write: '' empties a file, and the file stays",
    run: async (fs, seed) => {
      await seed.file('a.md', 'text\n');
      await fs.write(at('a.md'), '');
      same(await fs.readText(at('a.md')), '', 'empty');
      same(await fs.list(ROOT), ['a.md'], 'kept');
    },
  },
  {
    name: 'write: leaves no renamed twin, for a new file and for one that exists',
    run: async (fs) => {
      await fs.write(at('inbox/a.md'), 'first\n');
      await fs.write(at('inbox/a.md'), 'second\n');
      same(await fs.readText(at('inbox/a.md')), 'second\n', 'replaced');
      same(await fs.list(at('inbox')), ['a.md'], 'no twin');
      same(await fs.list(ROOT), ['inbox'], 'no folder twin');
    },
  },
  {
    name: 'write: a folder at the path throws and keeps what it holds, and a file where a parent belongs throws',
    run: async (fs, seed) => {
      await seed.file('스터디/CLAUDE.md', '# 스터디\n');
      await throws(fs.write(at('스터디'), 'x'), otherError, 'a folder');
      same(await fs.list(at('스터디')), ['CLAUDE.md'], 'contents');
      await throws(fs.write(at('스터디/CLAUDE.md/x.md'), 'x'), otherError, 'a file in the way');
      same(await fs.readText(at('스터디/CLAUDE.md')), '# 스터디\n', 'the file kept');
      same(await fs.list(ROOT), ['스터디'], 'no twin');
    },
  },
  {
    name: 'remove: removed, then readText is null and list no longer names it, and the parent stays',
    run: async (fs, seed) => {
      await seed.file('스터디/hold/a.md', 'a\n');
      await seed.file('스터디/hold/b.md', 'b\n');
      same(await fs.remove(at('스터디/hold/a.md')), 'removed', 'removed');
      same(await fs.readText(at('스터디/hold/a.md')), null, 'gone');
      same(await fs.list(at('스터디/hold')), ['b.md'], 'the other stays');
      same(await fs.remove(at('스터디/hold/b.md')), 'removed', 'the last one');
      same(await fs.list(at('스터디')), ['hold'], 'an empty parent stays');
    },
  },
  {
    name: "remove: 'absent' for a missing file and a missing parent, twice in a row",
    run: async (fs, seed) => {
      await seed.folder('inbox');
      for (const n of [1, 2]) {
        same(await fs.remove(at('inbox/a.md')), 'absent', `missing file ${n}`);
        same(await fs.remove(at('없음/a.md')), 'absent', `missing parent ${n}`);
      }
    },
  },
  {
    name: 'remove: a folder throws and keeps everything in it',
    run: async (fs, seed) => {
      await seed.file('스터디/wiki/RAG.md', 'x\n');
      await throws(fs.remove(at('스터디/wiki')), otherError, 'a folder');
      same(await fs.readText(at('스터디/wiki/RAG.md')), 'x\n', 'contents');
    },
  },
  {
    name: 'listTree: every file at any depth, NFC, sorted by code unit',
    run: async (fs, seed) => {
      await seed.file('스터디/wiki/RAG.md', 'r');
      await seed.file('스터디/wiki/인사이트/2026.md', 'i');
      await seed.file('스터디/wiki/answers/q.md', 'q');
      await seed.file(`스터디/wiki/${'주제/깊이/더 깊이/끝.md'.normalize('NFD')}`, 'd');
      await seed.file('스터디/wiki/photo.jpg', 'p');
      await seed.folder('스터디/wiki/비어 있음');
      same(await fs.listTree(at('스터디/wiki')), [
        '스터디/wiki/RAG.md', '스터디/wiki/answers/q.md', '스터디/wiki/photo.jpg', '스터디/wiki/인사이트/2026.md', '스터디/wiki/주제/깊이/더 깊이/끝.md',
      ], 'tree');
      same(await fs.listTree(ROOT), await fs.listTree(at('스터디')), 'the root lists the same files');
    },
  },
  {
    name: 'listTree: dot files and dot folders are skipped',
    run: async (fs, seed) => {
      await seed.file('wiki/.obsidian/app.json', '{}');
      await seed.file('wiki/.trash/old.md', 'x');
      await seed.file('wiki/.gitkeep', '');
      await seed.file('wiki/answers/.gitkeep', '');
      await seed.file('wiki/a.md', 'a');
      same(await fs.listTree(at('wiki')), ['wiki/a.md'], 'tree');
    },
  },
  {
    name: 'listTree: [] for a missing folder, and a file throws',
    run: async (fs, seed) => {
      await seed.file('CLAUDE.md', '# root\n');
      same(await fs.listTree(at('없음')), [], 'missing');
      same(await fs.listTree(at('없음/더 깊이')), [], 'missing parent');
      await throws(fs.listTree(at('CLAUDE.md')), otherError, 'a file');
    },
  },
  {
    name: 'write, remove, and listTree refuse a path that breaks the WikiPath rule, and write and remove refuse the root',
    run: async (fs) => {
      for (const bad of ['../x', '/x', 'a//b', 'a/', 'a\\b', './a', '스터디'.normalize('NFD')]) {
        await throws(fs.write(at(bad), 'x'), badPath, `write ${JSON.stringify(bad)}`);
        await throws(fs.remove(at(bad)), badPath, `remove ${JSON.stringify(bad)}`);
        await throws(fs.listTree(at(bad)), badPath, `listTree ${JSON.stringify(bad)}`);
      }
      await throws(fs.write(ROOT, 'x'), otherError, 'write the root');
      await throws(fs.remove(ROOT), otherError, 'remove the root');
    },
  },
  {
    name: 'readBytes: every byte value comes back exactly, an invalid UTF-8 run, CRLF, and a BOM included',
    run: async (fs, seed) => {
      await seed.bytes('_attachments/a-1.jpg', EVERY_BYTE);
      sameBytes(await fs.readBytes(at('_attachments/a-1.jpg')), EVERY_BYTE, 'bytes');
    },
  },
  {
    name: 'readBytes: null for a missing file, a missing parent, and a parent that is a file; a folder throws',
    run: async (fs, seed) => {
      await seed.file('CLAUDE.md', '# root\n');
      await seed.folder('_originals');
      same(await fs.readBytes(at('_originals/a-1.jpg')), null, 'missing file');
      same(await fs.readBytes(at('없음/a-1.jpg')), null, 'missing parent');
      same(await fs.readBytes(at('CLAUDE.md/a-1.jpg')), null, 'parent is a file');
      await throws(fs.readBytes(at('_originals')), otherError, 'a folder');
      await throws(fs.readBytes(at('../x')), badPath, 'a bad path');
    },
  },
  {
    name: 'readBytes: a file create wrote reads back as its UTF-8 bytes, and an empty file as no bytes',
    run: async (fs) => {
      await fs.create(at('a.md'), '도토리\r\n');
      sameBytes(await fs.readBytes(at('a.md')), new TextEncoder().encode('도토리\r\n'), 'utf-8');
      await fs.create(at('.gitkeep'), '');
      sameBytes(await fs.readBytes(at('.gitkeep')), new Uint8Array(), 'empty');
    },
  },
  {
    name: 'createBytes: makes the parent folders, answers created, and 3 MiB read back identical',
    run: async (fs) => {
      const b = big(3 * 1024 * 1024);
      same(await fs.createBytes(at('_originals/a-1.heic'), b), 'created', 'created');
      sameBytes(await fs.readBytes(at('_originals/a-1.heic')), b, '3 MiB');
      same(await fs.list(ROOT), ['_originals'], 'made folders');
    },
  },
  {
    name: 'createBytes: a second call answers exists, keeps the first bytes, and leaves no renamed twin',
    run: async (fs) => {
      same(await fs.createBytes(at('_attachments/a-1.jpg'), EVERY_BYTE), 'created', 'first');
      same(await fs.createBytes(at('_attachments/a-1.jpg'), big(1000)), 'exists', 'second');
      sameBytes(await fs.readBytes(at('_attachments/a-1.jpg')), EVERY_BYTE, 'kept');
      same(await fs.list(at('_attachments')), ['a-1.jpg'], 'no twin');
    },
  },
  {
    name: 'createBytes: an empty file is filled and answered created; empty bytes over an empty file are exists',
    run: async (fs, seed) => {
      await seed.bytes('_originals/a-1.jpg', new Uint8Array());
      same(await fs.createBytes(at('_originals/a-1.jpg'), EVERY_BYTE), 'created', 'filled');
      sameBytes(await fs.readBytes(at('_originals/a-1.jpg')), EVERY_BYTE, 'bytes');
      await seed.bytes('_originals/b-1.jpg', new Uint8Array());
      same(await fs.createBytes(at('_originals/b-1.jpg'), new Uint8Array()), 'exists', 'nothing to fill');
      same(await fs.list(at('_originals')), ['a-1.jpg', 'b-1.jpg'], 'no twin');
    },
  },
  {
    name: 'createBytes: a file with bytes is never touched, a prefix of the new bytes included',
    run: async (fs, seed) => {
      const prefix = EVERY_BYTE.subarray(0, 100);
      await seed.bytes('_originals/a-1.jpg', prefix);
      same(await fs.createBytes(at('_originals/a-1.jpg'), EVERY_BYTE), 'exists', 'exists');
      sameBytes(await fs.readBytes(at('_originals/a-1.jpg')), prefix, 'the prefix kept');
    },
  },
  {
    name: 'createBytes: names land exactly as asked, with nothing added',
    run: async (fs) => {
      for (const name of ['a-1.jpg', 'a-2.heic', 'a-3.png', 'a-4.webp', '.nomedia', '사진-1.jpg']) {
        same(await fs.createBytes(at(`_originals/${name}`), name === '.nomedia' ? new Uint8Array() : EVERY_BYTE), 'created', name);
      }
      same(await fs.list(at('_originals')), ['.nomedia', 'a-1.jpg', 'a-2.heic', 'a-3.png', 'a-4.webp', '사진-1.jpg'], 'names');
    },
  },
  {
    name: 'createBytes: a folder at the path throws and keeps what it holds; a file where a parent belongs throws',
    run: async (fs, seed) => {
      await seed.bytes('_attachments/x/a-1.jpg', EVERY_BYTE);
      await throws(fs.createBytes(at('_attachments/x'), EVERY_BYTE), otherError, 'a folder');
      sameBytes(await fs.readBytes(at('_attachments/x/a-1.jpg')), EVERY_BYTE, 'contents');
      await throws(fs.createBytes(at('_attachments/x/a-1.jpg/b.jpg'), EVERY_BYTE), otherError, 'a file in the way');
      await throws(fs.createBytes(ROOT, EVERY_BYTE), otherError, 'the root');
      same(await fs.list(ROOT), ['_attachments'], 'no twin');
    },
  },
  {
    name: 'listTree and remove see a bytes file like any other',
    run: async (fs) => {
      await fs.createBytes(at('_attachments/a-1.jpg'), EVERY_BYTE);
      same(await fs.listTree(at('_attachments')), ['_attachments/a-1.jpg'], 'listed');
      same(await fs.remove(at('_attachments/a-1.jpg')), 'removed', 'removed');
      same(await fs.readBytes(at('_attachments/a-1.jpg')), null, 'gone');
    },
  },
  {
    name: 'FolderUnreachable: readBytes and createBytes throw it once the folder is gone, and createBytes makes nothing',
    run: async (fs, seed) => {
      await seed.bytes('_originals/a-1.jpg', EVERY_BYTE);
      await seed.dropRoot();
      await throws(fs.readBytes(at('_originals/a-1.jpg')), unreachable, 'readBytes');
      await throws(fs.readBytes(at('_originals/b-1.jpg')), unreachable, 'readBytes missing');
      await throws(fs.createBytes(at('_originals/b-1.jpg'), EVERY_BYTE), unreachable, 'createBytes');
      await throws(fs.list(ROOT), unreachable, 'still gone after createBytes');
    },
  },
  {
    name: 'FolderUnreachable: write, remove, and listTree throw it once the folder is gone, and write makes nothing',
    run: async (fs, seed) => {
      await seed.file('CLAUDE.md', '# root\n');
      await seed.dropRoot();
      await throws(fs.write(at('스터디/wiki/a.md'), 'x'), unreachable, 'write');
      await throws(fs.write(at('CLAUDE.md'), 'x'), unreachable, 'write over');
      await throws(fs.remove(at('CLAUDE.md')), unreachable, 'remove');
      await throws(fs.listTree(ROOT), unreachable, 'listTree');
      await throws(fs.listTree(at('스터디')), unreachable, 'listTree under');
      await throws(fs.list(ROOT), unreachable, 'still gone after write');
    },
  },
];
