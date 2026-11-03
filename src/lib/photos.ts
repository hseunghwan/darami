import { MAX_PHOTOS, type PhotoOrigin } from '../core/photos';

export { MAX_PHOTOS };

/** A photo on the memo being written. Its bytes are already a file of ours, so the source app or grant can go away. */
export type DraftPhoto = {
  /** file:// under the app's files dir. */
  uri: string;
  origin: PhotoOrigin;
  /** From the photo's own GPS, never the phone's position now. */
  place: string | null;
  address: string | null;
};

/** A photo alone is a memo: accept allows empty text when attachments are present. */
export const canSend = (text: string, photos: readonly DraftPhoto[]): boolean => text.trim() !== '' || photos.length > 0;

/** Appends up to the cap and reports how many did not fit. */
export function addPhotos(current: readonly DraftPhoto[], added: readonly DraftPhoto[]): { photos: DraftPhoto[]; dropped: DraftPhoto[] } {
  const room = Math.max(0, MAX_PHOTOS - current.length);
  return { photos: [...current, ...added.slice(0, room)], dropped: added.slice(room) };
}
