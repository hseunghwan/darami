/**
 * What darami://photo-check feeds the phone's own code: the samples in samples.gen.ts, and
 * made-by-dotoriwiki's photo memo rebuilt from its photos. jest runs the same rebuild over the
 * same constants (__tests__/samples.test.ts), so a difference on a device is the device's.
 */

import { parseMemoFile, renderMemoFile } from '../core/pages';
import { attachmentOf, photoFacts, sniffPhoto, type AttachmentRequest } from '../core/photos';
import { readExifTags } from './exif';
import { FIXTURE_MEMO } from './samples.gen';

export { FIXTURE_MEMO, SAMPLES } from './samples.gen';

export const fromBase64 = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** What dotoriwiki's fixture script asked for each photo. */
const REQUESTS: readonly AttachmentRequest[] = [
  { n: 1, origin: 'gallery', place: '종로구 사직동', address: null },
  { n: 2, origin: 'camera', place: null, address: null },
];

/** The fixture's memo 5 rendered again from its two photos, with `sha256` from the caller's tools. */
export async function fixtureMemoFile(sha256: (b: Uint8Array) => Promise<string>): Promise<string> {
  const parsed = parseMemoFile(FIXTURE_MEMO.file);
  if (!parsed.ok) throw new Error(parsed.detail);
  const { memo, routing } = parsed.value;
  const attachments = [];
  for (const [i, b64] of FIXTURE_MEMO.photos.entries()) {
    const bytes = fromBase64(b64);
    const ext = sniffPhoto(bytes);
    if (!ext) throw new Error(`fixture photo ${i + 1} does not sniff as a photo`);
    const facts = photoFacts(await readExifTags(bytes), memo.tz);
    attachments.push(attachmentOf({ id: memo.id, req: REQUESTS[i]!, ext, sha256: await sha256(bytes), bytes: bytes.length, facts, memoFix: memo.location }));
  }
  return renderMemoFile({ ...memo, attachments }, routing);
}
