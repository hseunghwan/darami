/**
 * Every photo file the engine reads or writes. _originals/ and _attachments/ have no other writer,
 * so their rules live here once:
 *
 *   accept   original n, then copy n, for each n in request order; the memo file last (memos.ts).
 *            Until the memo file is whole the photos belong to no memo, and the phone still holds
 *            every pending byte.
 *   check    which embeds name a copy, one look per embed instead of a listing that only grows.
 *   open     sweep: what an accept wrote for a memo that never came, 7 days on, found by its rows.
 *
 * SAF has no rename, so no file appears whole at once. A rerun after a kill anywhere converges on
 * the bytes of an uncut run:
 *   original  createBytes never replaces. The same bytes are `same`; a proper prefix of them is a
 *             create a kill cut off, removed and made again; anything else is `conflict`.
 *   copy      one that is not a whole JPEG is cut off, removed and made again.
 *   record    rebuilt from the stored original's bytes every time, as dotoriwiki's was.
 */

import { paths, parseWikiPath, type WikiPath } from '../core/layout';
import {
  attachmentName, attachmentOf, COPY_JPEG, isPrefixOf, ORPHAN_PHOTO_MS, originalName, PHOTO_EXTS, photoFacts, sameBytes, sniffPhoto, wholeJpeg,
  type Attachment, type AttachmentRequest, type PhotoExt, type PhotoTools,
} from '../core/photos';
import type { Fs, ReadFs } from '../core/fs';
import type { NewMemo } from '../core/pages';
import { locate, type Places } from '../core/places';
import type { MemoId } from '../core/types';
import { readExifTags } from '../media/exif';

/** Photo n of the memo being accepted, as the phone holds it. null: that file is gone from the phone. */
export type PendingPhotos = (n: number) => Promise<Uint8Array | null>;
export const NO_PENDING: PendingPhotos = async () => null;

/**
 * Nothing of the memo was written. `missing`: no pending bytes and nothing stored. `unsupported`:
 * not an image the phone decodes. `conflict`: other bytes are already stored as photo n of this id.
 */
export type PhotoRefusal = { readonly kind: 'photo-refused'; readonly n: number; readonly reason: 'missing' | 'unsupported' | 'conflict' };

export type PhotoWrite = { readonly id: MemoId; readonly path: WikiPath; readonly at: string };

/** Part of the BookStore: what accept is writing, so the sweep never has to list the photo folders. */
export type PhotoWrites = {
  /** Before each create of a photo file. A row already there keeps its first `at`. */
  putPhotoWrite(w: PhotoWrite): Promise<void>;
  photoWrites(): Promise<readonly PhotoWrite[]>;
  dropPhotoWrites(id: MemoId): Promise<void>;
};

export type PhotoDeps = {
  readonly fs: Fs;
  readonly tools: PhotoTools;
  readonly writes: PhotoWrites;
  readonly now: () => Date;
  /** Where every memo is now; null while the config is broken and that cannot be told. */
  readonly places: () => Promise<Places | null>;
};

const originalPath = (id: MemoId, n: number, ext: PhotoExt) => `${paths.originals}/${originalName(id, n, ext)}` as WikiPath;
const copyPath = (id: MemoId, n: number) => `${paths.attachments}/${attachmentName(id, n)}` as WikiPath;
/** Keeps the phone's gallery from showing the wiki's photos a second time. dotoriwiki and core ignore dot names. */
const NO_MEDIA = [paths.originals, paths.attachments].map((dir) => `${dir}/.nomedia` as WikiPath);

export function photoFiles(deps: PhotoDeps) {
  const { fs, tools, writes } = deps;
  const note = (id: MemoId, path: WikiPath) => writes.putPhotoWrite({ id, path, at: deps.now().toISOString() });
  let noMedia = false;

  /** createBytes, then the prefix rule. */
  async function storeOriginal(id: MemoId, path: WikiPath, bytes: Uint8Array): Promise<Uint8Array | 'conflict'> {
    await note(id, path);
    if ((await fs.createBytes(path, bytes)) === 'created') return bytes;
    const kept = await fs.readBytes(path);
    if (kept && sameBytes(kept, bytes)) return kept;
    if (kept && !isPrefixOf(kept, bytes)) return 'conflict';
    // Cut off part way: only this memo's accept writes this name.
    await fs.remove(path);
    return (await fs.createBytes(path, bytes)) === 'created' ? bytes : 'conflict';
  }

  /** The original already stored for photo n, found by four looks rather than a listing of _originals/. */
  async function storedOriginal(id: MemoId, n: number): Promise<{ readonly ext: PhotoExt; readonly bytes: Uint8Array } | null> {
    for (const ext of PHOTO_EXTS) {
      const bytes = await fs.readBytes(originalPath(id, n, ext));
      if (bytes?.length) return { ext, bytes };
    }
    return null;
  }

  /** The 2048 px copy, made once; one cut off is made again. false: the phone cannot decode the original. */
  async function ensureCopy(id: MemoId, n: number, original: Uint8Array): Promise<boolean> {
    const path = copyPath(id, n);
    const there = await fs.readBytes(path);
    if (there && wholeJpeg(there)) return true;
    if (there) await fs.remove(path);
    const copy = await tools.jpeg(original, COPY_JPEG);
    if (!copy) return false;
    await note(id, path);
    await fs.createBytes(path, copy);
    return true;
  }

  async function attachOne(memo: NewMemo, req: AttachmentRequest, pending: PendingPhotos): Promise<Attachment | PhotoRefusal> {
    const refuse = (reason: PhotoRefusal['reason']): PhotoRefusal => ({ kind: 'photo-refused', n: req.n, reason });
    const held = await pending(req.n);
    let stored: { readonly ext: PhotoExt; readonly bytes: Uint8Array };
    if (held) {
      const ext = sniffPhoto(held);
      if (!ext) return refuse('unsupported');
      const bytes = await storeOriginal(memo.id, originalPath(memo.id, req.n, ext), held);
      if (bytes === 'conflict') return refuse('conflict');
      stored = { ext, bytes };
    } else {
      const found = await storedOriginal(memo.id, req.n);
      if (!found) return refuse('missing');
      stored = found;
    }
    if (!(await ensureCopy(memo.id, req.n, stored.bytes))) {
      // As dotoriwiki deleted an original sips could not read. Only while the phone still holds it.
      if (held) await fs.remove(originalPath(memo.id, req.n, stored.ext));
      return refuse('unsupported');
    }
    return attachmentOf({
      id: memo.id,
      req,
      ext: stored.ext,
      sha256: await tools.sha256(stored.bytes),
      bytes: stored.bytes.length,
      facts: photoFacts(await readExifTags(stored.bytes), memo.tz),
      memoFix: memo.location,
    });
  }

  return {
    /** Every photo of the memo in request order, one original's bytes in memory at a time. */
    async attachAll(memo: NewMemo, pending: PendingPhotos): Promise<readonly Attachment[] | PhotoRefusal> {
      if (!noMedia) {
        for (const path of NO_MEDIA) await fs.createBytes(path, new Uint8Array());
        noMedia = true;
      }
      const out: Attachment[] = [];
      for (const req of memo.attachments) {
        const a = await attachOne(memo, req, pending);
        if ('kind' in a) return a;
        out.push(a);
      }
      return out;
    },

    /** The memo file is whole: its rows go, so the sweep never looks at its photos. */
    settled: (id: MemoId) => writes.dropPhotoWrites(id),

    /** Rows older than ORPHAN_PHOTO_MS whose memo is nowhere have their files removed; every old row then goes. No rows costs one SQLite read. */
    async sweep(): Promise<void> {
      const cutoff = deps.now().getTime() - ORPHAN_PHOTO_MS;
      const old = (await writes.photoWrites()).filter((w) => Date.parse(w.at) < cutoff);
      if (old.length === 0) return;
      const p = await deps.places();
      if (!p) return;
      for (const id of new Set(old.map((w) => w.id))) {
        if (!p.inbox.has(id) && !locate(p, id)) for (const w of old) if (w.id === id) await fs.remove(w.path);
        await writes.dropPhotoWrites(id);
      }
    },

    /** The image embeds among `targets` that name a file in _attachments/: check()'s set. */
    async existing(read: Pick<ReadFs, 'readBytes'>, targets: readonly string[]): Promise<ReadonlySet<string>> {
      const out = new Set<string>();
      for (const t of targets) {
        const path = t.includes('/') ? null : parseWikiPath(`${paths.attachments}/${t}`);
        if (path && (await read.readBytes(path)) !== null) out.add(t);
      }
      return out;
    },
  };
}

export type PhotoFiles = ReturnType<typeof photoFiles>;
