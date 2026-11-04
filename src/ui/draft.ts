/**
 * The memo tab's draft, kept in kv half a second after each change, so a kill (the OS's, or one
 * mid-accept) gives the text and the photos back. A kept draft whose id the book already holds was
 * filed before the kill, and is dropped with its photos' files.
 */

import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { MemoId } from '../core/types';
import type { PhotoRefusal } from '../jobs/engine';
import { kv } from '../lib/db';
import { DRAFT_KEY, draftAfter, parseSavedDraft, savedDraft, type Draft } from '../lib/draft';
import { removeQuietly } from '../lib/files';
import { addPhotos, type DraftPhoto } from '../lib/photos';
import { useApp } from '../state';

/** The draft's photos as the photo buttons and strip change them. The memo tab and the share sheet both have one. */
export type PhotoHost = {
  readonly photos: readonly DraftPhoto[];
  addPhotos(photos: readonly DraftPhoto[]): void;
  /** Takes the photo off and deletes its file. */
  removePhoto(uri: string): void;
};

export type DraftBox = Draft &
  PhotoHost & {
    setText(text: string): void;
    setHint(hint: string | null): void;
    /** accept wrote nothing: the photo it names goes, file and all, or the draft takes a new id. */
    refused(r: PhotoRefusal): void;
    /** fileMemo answered `filed` for this draft. */
    filed(): void;
  };

const fresh = (): Draft => ({ id: Crypto.randomUUID(), text: '', hint: null, photos: [] });

/** The reducer with the file work its events need. `kept` saves to kv; the share sheet's draft is not kept. */
export function useDraft(kept = true, initial: () => Draft = fresh): DraftBox {
  const [draft, dispatch] = useReducer(draftAfter, null, initial);
  const restored = useRef(!kept);
  const photos = useRef(draft.photos);
  photos.current = draft.photos;

  useEffect(() => {
    if (!kept) return;
    void kv.get(DRAFT_KEY).then(
      (text) => {
        const saved = parseSavedDraft(text);
        const gone = saved?.photos.filter((p) => !new File(p.uri).exists).map((p) => p.uri) ?? [];
        dispatch({ kind: 'restored', saved, gone, next: Crypto.randomUUID() });
        restored.current = true;
      },
      () => void (restored.current = true),
    );
  }, [kept]);

  useEffect(() => {
    if (!kept || !restored.current) return;
    const t = setTimeout(() => {
      const saved = savedDraft(draft);
      void (saved === null ? kv.remove(DRAFT_KEY) : kv.set(DRAFT_KEY, saved)).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [draft, kept]);

  const filedBefore = useApp((a) => kept && (a.book?.byId.has(draft.id as MemoId) ?? false));
  const filed = useCallback(() => {
    removeQuietly(photos.current.map((p) => p.uri));
    dispatch({ kind: 'filed', id: draft.id, next: Crypto.randomUUID() });
  }, [draft.id]);
  useEffect(() => {
    if (filedBefore) filed();
  }, [filedBefore, filed]);

  return {
    ...draft,
    setText: (text) => dispatch({ kind: 'typed', text }),
    setHint: (hint) => dispatch({ kind: 'hinted', hint }),
    addPhotos: (added) => {
      removeQuietly(addPhotos(photos.current, added).dropped.map((p) => p.uri));
      dispatch({ kind: 'photos-added', photos: added });
    },
    removePhoto: (uri) => {
      removeQuietly([uri]);
      dispatch({ kind: 'photo-removed', uri, next: Crypto.randomUUID() });
    },
    refused: (refusal) => {
      const photo = photos.current[refusal.n - 1];
      if (refusal.reason !== 'conflict' && photo) removeQuietly([photo.uri]);
      dispatch({ kind: 'refused', refusal, next: Crypto.randomUUID() });
    },
    filed,
  };
}
