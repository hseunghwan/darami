/**
 * A memo being written, as a reducer, so the rules a kill or a slow accept must not break are pure.
 * The memo tab keeps it in kv; the share sheet holds it only while it is open. Its id is the
 * memo's id: sending again after an accept cut off fills the same files rather than filing a
 * second memo.
 *
 * accept stores photo n as `<id>-<n>` and never replaces a stored original, so for one draft id
 * photo n must always name the same bytes. Taking a photo off renumbers the ones after it, so it
 * gives the draft a new id. Adding photos keeps the id: nothing is stored for their numbers yet.
 */

import { MAX_PHOTOS, PHOTO_ORIGINS, type PhotoOrigin } from '../core/photos';
import { addPhotos, type DraftPhoto } from './photos';
import type { PhotoRefusal } from '../jobs/engine';

/** The kv key of the memo tab's draft. */
export const DRAFT_KEY = 'draft';

export type Draft = { readonly id: string; readonly text: string; readonly hint: string | null; readonly photos: readonly DraftPhoto[] };

export type DraftEvent =
  | { readonly kind: 'typed'; readonly text: string }
  | { readonly kind: 'hinted'; readonly hint: string | null }
  /** Past MAX_PHOTOS they are not added; the caller deletes what addPhotos reports dropped. */
  | { readonly kind: 'photos-added'; readonly photos: readonly DraftPhoto[] }
  | { readonly kind: 'photo-removed'; readonly uri: string; readonly next: string }
  /** accept wrote nothing: photo n goes (missing, unsupported), or the draft takes a new id (conflict). */
  | { readonly kind: 'refused'; readonly refusal: PhotoRefusal; readonly next: string }
  /** The copy kept from the last launch, less the photos whose files are gone. Anything typed or picked meanwhile wins. */
  | { readonly kind: 'restored'; readonly saved: Draft | null; readonly gone: readonly string[]; readonly next: string }
  /** accept answered for `id`, or the book already holds it: a new, empty draft, the chip kept. */
  | { readonly kind: 'filed'; readonly id: string; readonly next: string };

export function draftAfter(d: Draft, e: DraftEvent): Draft {
  switch (e.kind) {
    case 'typed':
      return { ...d, text: e.text };
    case 'hinted':
      return { ...d, hint: e.hint };
    case 'photos-added':
      return { ...d, photos: addPhotos(d.photos, e.photos).photos };
    case 'photo-removed':
      return d.photos.some((p) => p.uri === e.uri) ? { ...d, id: e.next, photos: d.photos.filter((p) => p.uri !== e.uri) } : d;
    case 'refused':
      return e.refusal.reason === 'conflict' ? { ...d, id: e.next } : { ...d, id: e.next, photos: d.photos.filter((_, i) => i !== e.refusal.n - 1) };
    case 'restored': {
      if (!e.saved || d.text !== '' || d.photos.length > 0) return d;
      const photos = e.saved.photos.filter((p) => !e.gone.includes(p.uri));
      return { ...e.saved, id: photos.length < e.saved.photos.length ? e.next : e.saved.id, photos };
    }
    case 'filed':
      return e.id === d.id ? { id: e.next, text: '', hint: d.hint, photos: [] } : d;
  }
}

/** What kv keeps for the draft: null removes it. */
export const savedDraft = (d: Draft): string | null => (d.text.trim() === '' && d.photos.length === 0 ? null : JSON.stringify(d));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strOrNull = (v: unknown) => (typeof v === 'string' ? v : null);

/** kv is not trusted as a path: a photo must be a file:/// URI with a known origin, at most MAX_PHOTOS of them. */
function photosOf(v: unknown): DraftPhoto[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((p): p is Record<string, unknown> => isRecord(p) && typeof p.uri === 'string' && p.uri.startsWith('file:///') && PHOTO_ORIGINS.includes(p.origin as PhotoOrigin))
    .slice(0, MAX_PHOTOS)
    .map((p) => ({ uri: p.uri as string, origin: p.origin as PhotoOrigin, place: strOrNull(p.place), address: strOrNull(p.address) }));
}

export function parseSavedDraft(text: string | null): Draft | null {
  try {
    const v = text ? (JSON.parse(text) as Partial<Draft>) : null;
    if (!v || typeof v.id !== 'string' || v.id === '' || typeof v.text !== 'string') return null;
    return { id: v.id, text: v.text, hint: typeof v.hint === 'string' ? v.hint : null, photos: photosOf(v.photos) };
  } catch {
    return null;
  }
}
