/**
 * The memo tab's draft, kept in kv half a second after each change, so a kill (the OS's, or one
 * mid-accept) gives the text back. A kept draft whose id the book already holds was filed before
 * the kill, and is dropped.
 */

import * as Crypto from 'expo-crypto';
import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { MemoId } from '../core/types';
import { kv } from '../lib/db';
import { draftAfter, parseSavedDraft, savedDraft, type Draft } from '../lib/draft';
import { useApp } from '../state';

const KEY = 'draft';

export type DraftBox = Draft & {
  setText(text: string): void;
  setHint(hint: string | null): void;
  /** fileMemo answered `filed` for this draft. */
  filed(): void;
};

export function useDraft(): DraftBox {
  const [draft, dispatch] = useReducer(draftAfter, null, () => ({ id: Crypto.randomUUID(), text: '', hint: null }));
  const restored = useRef(false);

  useEffect(() => {
    void kv.get(KEY).then(
      (text) => {
        dispatch({ kind: 'restored', saved: parseSavedDraft(text) });
        restored.current = true;
      },
      () => void (restored.current = true),
    );
  }, []);

  useEffect(() => {
    if (!restored.current) return;
    const t = setTimeout(() => {
      const saved = savedDraft(draft);
      void (saved === null ? kv.remove(KEY) : kv.set(KEY, saved)).catch(() => {});
    }, 500);
    return () => clearTimeout(t);
  }, [draft]);

  const filedBefore = useApp((a) => a.book?.byId.has(draft.id as MemoId) ?? false);
  const filed = useCallback(() => dispatch({ kind: 'filed', id: draft.id, next: Crypto.randomUUID() }), [draft.id]);
  useEffect(() => {
    if (filedBefore) filed();
  }, [filedBefore, filed]);

  return {
    ...draft,
    setText: (text) => dispatch({ kind: 'typed', text }),
    setHint: (hint) => dispatch({ kind: 'hinted', hint }),
    filed,
  };
}
