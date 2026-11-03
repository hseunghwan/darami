/**
 * The Fs port over node:fs, for jest. Never bundled: tsconfig.app.json leaves this file out, so an
 * import of it from app code fails `npm run typecheck`.
 *
 * Lookups are byte-exact. Matching an NFD name on disk by its NFC path is the SAF adapter's job.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Fs } from '../core/fs';
import { parseWikiPath } from '../core/layout';

/** `root` is the wiki folder, an absolute directory. */
export function nodeFs(root: string): Fs {
  return {
    async readText(path) {
      if (parseWikiPath(path) !== path) throw new Error(`not a wiki path: ${JSON.stringify(path)}`);
      try {
        return await readFile(join(root, ...path.split('/')), 'utf8');
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return null;
        throw e;
      }
    },
  };
}
