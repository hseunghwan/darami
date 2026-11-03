/**
 * The Fs port over node:fs, for jest. Never bundled: tsconfig.app.json leaves this file out, so an
 * import of it from app code fails `npm run typecheck`.
 *
 * Lookups are byte-exact. Matching an NFD name on disk by its NFC path is a fact of Android's
 * storage, checked on SAF by darami://fs-check, not something jest needs from this adapter.
 */

import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FolderUnreachable, type Fs } from '../core/fs';
import { parseWikiPath, ROOT, type WikiPath } from '../core/layout';

const codeOf = (e: unknown) => (e as NodeJS.ErrnoException).code;
const absent = (e: unknown) => codeOf(e) === 'ENOENT' || codeOf(e) === 'ENOTDIR';

/** `root` is the wiki folder, an absolute directory. */
export function nodeFs(root: string): Fs {
  const full = (path: WikiPath) => {
    if (parseWikiPath(path) !== path) throw new Error(`not a wiki path: ${JSON.stringify(path)}`);
    return join(root, ...path.split('/'));
  };

  async function rootAnswers(): Promise<void> {
    try {
      await stat(root);
    } catch (e) {
      if (codeOf(e) === 'ENOENT') throw new FolderUnreachable(root);
      throw e;
    }
  }

  return {
    async readText(path) {
      const at = full(path);
      try {
        return await readFile(at, 'utf8');
      } catch (e) {
        if (!absent(e)) throw e;
        await rootAnswers();
        return null;
      }
    },

    async list(dir) {
      const at = full(dir);
      let names: string[];
      try {
        names = await readdir(at);
      } catch (e) {
        if (!absent(e)) throw e;
        if (await stat(at).then((s) => s.isFile(), () => false)) throw new Error(`${dir} is a file`);
        await rootAnswers();
        return [];
      }
      return [...new Set(names.map((n) => n.normalize('NFC')))].sort();
    },

    async create(path, text) {
      const at = full(path);
      if (path === ROOT) throw new Error('the folder itself is not a file');
      // Before mkdir, which would otherwise make a deleted root again.
      await rootAnswers();
      await mkdir(dirname(at), { recursive: true });
      try {
        await writeFile(at, text, { flag: 'wx' });
        return 'created';
      } catch (e) {
        if (codeOf(e) !== 'EEXIST') throw e;
      }
      const s = await stat(at);
      if (s.isDirectory()) throw new Error(`${path} is a folder`);
      if (s.size > 0 || text === '') return 'exists';
      await writeFile(at, text, { flag: 'r+' });
      return 'created';
    },

    async write(path, text) {
      const at = full(path);
      if (path === ROOT) throw new Error('the folder itself is not a file');
      await rootAnswers();
      await mkdir(dirname(at), { recursive: true });
      if (await stat(at).then((s) => s.isDirectory(), () => false)) throw new Error(`${path} is a folder`);
      await writeFile(at, text);
    },

    async remove(path) {
      const at = full(path);
      if (path === ROOT) throw new Error('the folder itself is not a file');
      if (await stat(at).then((s) => s.isDirectory(), () => false)) throw new Error(`${path} is a folder`);
      try {
        await unlink(at);
        return 'removed';
      } catch (e) {
        if (!absent(e)) throw e;
        await rootAnswers();
        return 'absent';
      }
    },

    async listTree(dir) {
      const at = full(dir);
      const top = await stat(at).catch((e: unknown) => {
        if (!absent(e)) throw e;
        return null;
      });
      if (!top) {
        await rootAnswers();
        return [];
      }
      if (!top.isDirectory()) throw new Error(`${dir} is a file`);
      const out: string[] = [];
      const walk = async (rel: string, abs: string): Promise<void> => {
        for (const e of await readdir(abs, { withFileTypes: true })) {
          const name = e.name.normalize('NFC');
          if (name.startsWith('.')) continue;
          const child = rel === '' ? name : `${rel}/${name}`;
          if (e.isDirectory()) await walk(child, join(abs, e.name));
          else if (e.isFile()) out.push(child);
        }
      };
      await walk(dir, at);
      return [...new Set(out)].sort() as WikiPath[];
    },
  };
}
