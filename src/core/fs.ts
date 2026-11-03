/**
 * The Fs port: the wiki folder as the engine sees it. One Fs is bound to one folder, a SAF tree on
 * the phone or a directory under jest (src/fs/node.ts).
 *
 * The contract, for this method and every later one:
 * - Paths are WikiPaths (layout.ts), so they are relative, NFC, and cannot leave the folder. An
 *   adapter whose storage can hold another normalization, such as a name synced from a Mac as NFD,
 *   finds the entry whose NFC form matches.
 * - Absence is a value. Anything else throws: a revoked permission, an I/O error, a folder where a
 *   file was expected. The engine catches none of it.
 * - Async, because SAF answers over a binder call.
 *
 * A method joins the port with the phase whose code first calls it, so no method's semantics are
 * guessed before SAF has been tried. docs/plan.md lists the expected additions.
 */

import type { WikiPath } from './layout';

export type Fs = {
  /** The file's text decoded as UTF-8, exactly as stored (a BOM and CRLF kept). null when no file is there, a missing parent included. Throws on a folder. */
  readText(path: WikiPath): Promise<string | null>;
};
