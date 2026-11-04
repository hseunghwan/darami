/**
 * The Fs port: the wiki folder as the engine sees it. One Fs is bound to one folder, a SAF tree on
 * the phone (src/fs/saf.ts) or a directory under jest (src/fs/node.ts).
 *
 * The contract, for these methods and every later one. src/fs/contract.ts is its executable form:
 * jest runs it on the node adapter, and darami://fs-check runs it on SAF on a device.
 * - Paths are WikiPaths (layout.ts), so they are relative, NFC, and cannot leave the folder. Names
 *   an Fs returns are NFC.
 * - Names compare the way the storage compares them. Android's shared storage folds case and
 *   normalization (`HELLO.md` finds `hello.md`); node on Linux does not. Core never makes two names
 *   that differ only in case or normalization.
 * - Absence is a value only while the folder answers. When the bound folder itself is gone or its
 *   grant was revoked, every method throws FolderUnreachable, because SAF reports a revoked tree as
 *   "nothing there" and the engine would otherwise read it as an empty folder.
 * - Anything else throws: an I/O error, a folder where a file was expected, a file where a folder
 *   was expected. The engine catches none of it, FolderUnreachable aside.
 * - Nothing is atomic. SAF has no rename, so a file cannot appear whole at once: a reader or a
 *   crash can see a file that is empty or partly written. create only writes into a file it made
 *   or one that was empty, so a crash never mixes two texts. write is the one method that
 *   replaces text, and it is not atomic either: the engine journals a file's old text before it
 *   writes (src/jobs/transaction.ts).
 * - Async, because SAF answers over a binder call.
 *
 * A method joins the port with the phase whose code first calls it, so no method's semantics are
 * guessed before SAF has been tried. docs/plan.md lists the expected additions.
 */

import type { WikiPath } from './layout';

/** The folder this Fs is bound to does not answer: deleted, moved, on a removed card, or its grant revoked. */
export class FolderUnreachable extends Error {
  constructor(detail: string) {
    super(`the wiki folder cannot be reached: ${detail}`);
    this.name = 'FolderUnreachable';
  }
}

export type Fs = {
  /** The file's text decoded as UTF-8, exactly as stored (a BOM and CRLF kept). null when no file is there, a missing parent included. Throws on a folder. */
  readText(path: WikiPath): Promise<string | null>;

  /**
   * The names directly in `dir`, files and folders alike: NFC, distinct, sorted by UTF-16 code
   * unit, dot names included (core decides what a dot name means). `[]` when `dir` is missing.
   * Throws when `dir` is a file.
   */
  list(dir: WikiPath): Promise<readonly string[]>;

  /**
   * Makes the file `path` holding `text`, making missing parent folders on the way. Never replaces
   * text:
   * - 'created': no file was there, or an empty one was, and it now holds all of `text`. An empty
   *   file counts as missing because it is what a create cut off between making the file and
   *   writing it leaves, so a rerun finishes the job.
   * - 'exists': a file with at least one byte is at `path`, or an empty one is and `text` is ''.
   *   It is left as it was.
   * Throws on a folder at `path`, a file where a parent folder should be, and ROOT. Leaves no
   * renamed twin (`x.md (1)`) behind, whatever the storage does on a clash. Resolves only after the
   * last byte is written.
   */
  create(path: WikiPath, text: string): Promise<'created' | 'exists'>;

  /**
   * The file `path` now holds exactly `text`, made with its missing parent folders when absent.
   * Truncates, then writes, so a crash part way leaves the file empty or holding a prefix of
   * `text`'s UTF-8 bytes, never old bytes after new ones. On storage that folds case, writing `C.md`
   * beside `c.md` writes c.md and keeps its name. Throws on a folder at `path`, a file where a
   * parent folder should be, and ROOT. Leaves no renamed twin. Resolves after the last byte.
   */
  write(path: WikiPath, text: string): Promise<void>;

  /**
   * Deletes the file `path`. 'absent' when no file is there, a missing parent included, so a rerun
   * after a crash changes nothing. Never deletes a folder: a folder at `path` throws and keeps
   * what it holds. Leaves the parent folder, empty or not.
   */
  remove(path: WikiPath): Promise<'removed' | 'absent'>;

  /**
   * Every file under `dir` at any depth: NFC, distinct, sorted by UTF-16 code unit. A name starting
   * with `.` is skipped and a folder with such a name is not entered, so .obsidian/ and .trash/ cost
   * nothing. `[]` when `dir` is missing. Throws when `dir` is a file. Not limited to `.md`.
   */
  listTree(dir: WikiPath): Promise<readonly WikiPath[]>;

  /** The file's bytes exactly as stored. null when no file is there, a missing parent included. Throws on a folder. */
  readBytes(path: WikiPath): Promise<Uint8Array | null>;

  /**
   * create's rules, for bytes: makes `path` with its missing parent folders, holding `bytes`, and
   * never replaces a byte. 'created' when no file was there or an empty one was; 'exists' when a
   * file with at least one byte is there, or an empty one is and `bytes` is empty. A kill inside
   * the write can leave a prefix of `bytes`: the caller, which knows what the bytes should be,
   * decides what that means. Throws, and leaves no renamed twin, as create does.
   */
  createBytes(path: WikiPath, bytes: Uint8Array): Promise<'created' | 'exists'>;
};

/** The Fs with no way to change a file: what a chat, the page viewer, and the save-time check read through. */
export type ReadFs = Pick<Fs, 'readText' | 'list' | 'listTree' | 'readBytes'>;
