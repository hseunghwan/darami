/**
 * The Fs port over a SAF tree, on expo-file-system's File and Directory with document URIs built by
 * saf-uri.ts. Each rule below answers a trap measured on the Android 16 emulator (expo-file-system
 * 58.0.13); __tests__/saf-source.test.ts holds this file to the ones tsc cannot see.
 *
 * - `new File(dir, name)` resolves to the tree itself, so every URI comes from documentUri and no
 *   constructor here takes two arguments.
 * - `new File(u).exists` is true only for a file, `new Directory(u).exists` only for a folder.
 *   `text()` on a missing file throws the same code as an I/O error, so it runs only after a check.
 * - A revoked grant answers `exists` false and `list()` [], never a throw, so every "nothing there"
 *   asks whether the bound folder still answers (rootAnswers).
 * - createFile never fails on a clash: it renames (`c.md (1)`, and `C.md (2)` beside `c.md`). create
 *   looks first, and when a race still renames, it compares names and discards the twin.
 * - A null MIME turns `a.md` into `a.md.txt`; application/octet-stream kept every name exactly.
 * - `write()` does not truncate. writeWhole, the only writer and the only `open`, opens with Truncate.
 * - `delete()` on a folder deletes everything in it. discardTwin deletes only what this same call
 *   just made, and removeFile takes only a File, which `exists` showed to be a file.
 * - `delete()` on a missing file throws, so remove answers a lost race as 'absent' after a second look.
 * - makeFile is the only createFile, so the twin check and the MIME constant stay in one place.
 *
 * No cache: Obsidian and Syncthing change the same folder.
 */

import { Directory, File, FileMode } from 'expo-file-system';
import { FolderUnreachable, type Fs } from '../core/fs';
import { parseWikiPath, ROOT, type WikiPath } from '../core/layout';
import { documentUri, initialUriOf, parseSafTree, type SafTree } from './saf-uri';

const MIME = 'application/octet-stream';

export function safFs(tree: SafTree): Fs {
  const fileAt = (p: WikiPath) => new File(documentUri(tree, p));
  const dirAt = (p: WikiPath) => new Directory(documentUri(tree, p));

  function rootAnswers(): void {
    if (!dirAt(ROOT).exists) throw new FolderUnreachable(tree.uri);
  }

  /** The folder `path`, made one segment at a time where missing. */
  function ensureFolder(path: WikiPath): Directory {
    rootAnswers();
    let at = ROOT;
    let dir = dirAt(ROOT);
    for (const seg of path === ROOT ? [] : path.split('/')) {
      at = (at === ROOT ? seg : `${at}/${seg}`) as WikiPath;
      const next = dirAt(at);
      if (!next.exists) {
        if (fileAt(at).exists) throw new Error(`${at} is a file, so nothing can be made under it`);
        const made = dir.createDirectory(seg);
        if (made.name.normalize('NFC') !== seg) {
          discardTwin(made);
          if (!dirAt(at).exists) throw new Error(`the storage would store the folder ${at} as ${made.name}`);
        }
      }
      dir = next;
    }
    return dir;
  }

  /**
   * A new empty file at `path`, its parent folders made. null when something took the name between
   * the caller's look and createFile: that file may still be being written, so it is never filled.
   */
  function makeFile(path: WikiPath): File | null {
    const slash = path.lastIndexOf('/');
    const name = path.slice(slash + 1);
    const parent = ensureFolder((slash < 0 ? ROOT : path.slice(0, slash)) as WikiPath);
    const made = parent.createFile(name, MIME);
    if (made.name.normalize('NFC') === name) return made;
    discardTwin(made);
    if (fileAt(path).exists) return null;
    if (dirAt(path).exists) throw new Error(`${path} is a folder`);
    throw new Error(`the storage would store ${path} as ${made.name}`);
  }

  return {
    async readText(path) {
      guard(path);
      const f = fileAt(path);
      if (f.exists) return f.text();
      if (dirAt(path).exists) throw new Error(`${path} is a folder`);
      rootAnswers();
      return null;
    },

    async list(dir) {
      guard(dir);
      const d = dirAt(dir);
      if (!d.exists) {
        if (fileAt(dir).exists) throw new Error(`${dir} is a file`);
        rootAnswers();
        return [];
      }
      return [...new Set(d.list().map((e) => e.name.normalize('NFC')))].sort();
    },

    async create(path, text) {
      guard(path);
      if (path === ROOT) throw new Error('the folder itself is not a file');
      const there = fileAt(path);
      if (there.exists) return fill(there, text);
      if (dirAt(path).exists) throw new Error(`${path} is a folder`);
      const made = makeFile(path);
      if (!made) return 'exists';
      if (text !== '') await writeWhole(made, text);
      return 'created';
    },

    async write(path, text) {
      guard(path);
      if (path === ROOT) throw new Error('the folder itself is not a file');
      const there = fileAt(path);
      if (there.exists) return writeWhole(there, text);
      if (dirAt(path).exists) throw new Error(`${path} is a folder`);
      await writeWhole(makeFile(path) ?? fileAt(path), text);
    },

    async remove(path) {
      guard(path);
      if (path === ROOT) throw new Error('the folder itself is not a file');
      const f = fileAt(path);
      if (!f.exists) {
        if (dirAt(path).exists) throw new Error(`${path} is a folder`);
        rootAnswers();
        return 'absent';
      }
      try {
        removeFile(f);
      } catch (e) {
        if (fileAt(path).exists) throw e;
        return 'absent';
      }
      return 'removed';
    },

    async listTree(dir) {
      guard(dir);
      if (!dirAt(dir).exists) {
        if (fileAt(dir).exists) throw new Error(`${dir} is a file`);
        rootAnswers();
        return [];
      }
      const out: WikiPath[] = [];
      const walk = (at: WikiPath) => {
        for (const e of dirAt(at).list()) {
          const name = e.name.normalize('NFC');
          if (name.startsWith('.')) continue;
          const child = (at === ROOT ? name : `${at}/${name}`) as WikiPath;
          if (e instanceof Directory) walk(child);
          else out.push(child);
        }
      };
      walk(dir);
      return [...new Set(out)].sort();
    },
  };
}

/** The empty-file rule of the port's create. */
async function fill(file: File, text: string): Promise<'created' | 'exists'> {
  if (file.size > 0 || text === '') return 'exists';
  await writeWhole(file, text);
  return 'created';
}

/** writeBytes is async, and a handle closed before it settles rejects, so it is awaited inside the try. */
async function writeWhole(file: File, text: string): Promise<void> {
  const handle = file.open(FileMode.Truncate);
  try {
    await handle.writeBytes(new TextEncoder().encode(text));
  } finally {
    handle.close();
  }
}

function removeFile(file: File): void {
  file.delete();
}

/** A twin folder is fresh and so empty; it is checked anyway, because Directory.delete is recursive. */
function discardTwin(made: File | Directory): void {
  if (made instanceof Directory && made.list().length > 0) throw new Error(`refusing to delete ${made.uri}: not empty`);
  made.delete();
}

/** The brand is not checked at run time, and a `..` in a document id would leave the tree. */
function guard(path: WikiPath): void {
  if (parseWikiPath(path) !== path) throw new Error(`not a wiki path: ${JSON.stringify(path)}`);
}

export type Picked = { readonly kind: 'cancelled' } | { readonly kind: 'unsupported'; readonly provider: string } | { readonly kind: 'picked'; readonly tree: SafTree };

/** The system folder picker, opened at `current` or Documents. It takes a persistable grant, so the tree keeps working after a restart. */
export async function pickSafTree(current: SafTree | null): Promise<Picked> {
  let dir: Directory;
  try {
    dir = await Directory.pickDirectoryAsync(initialUriOf(current));
  } catch (e) {
    if ((e as { code?: unknown }).code === 'ERR_PICKER_CANCELLED') return { kind: 'cancelled' };
    throw e;
  }
  const t = parseSafTree(dir.uri);
  return t.ok ? { kind: 'picked', tree: t.value } : { kind: 'unsupported', provider: t.detail };
}
