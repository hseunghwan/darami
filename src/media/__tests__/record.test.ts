/**
 * The record accept writes, held to the bytes dotoriwiki wrote: made-by-dotoriwiki's photo memo
 * rebuilt from its two photos through exifr, the core rules, and renderMemoFile.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderMemoFile } from '../../core/pages';
import { attachmentOf, photoFacts, sniffPhoto, type AttachmentRequest } from '../../core/photos';
import type { MemoId } from '../../core/types';
import { memo, ulid } from '../../core/__tests__/helpers';
import { readExifTags } from '../exif';
import { bytes, GALAXY_JPEG, PLAIN_JPEG } from './exif';

const FIXTURE = join(__dirname, '..', '..', 'core', '__tests__', 'fixtures', 'made-by-dotoriwiki');
const SEOUL = { lat: 37.5665, lon: 126.978, place: '중구 태평로1가', address: '서울특별시 중구 세종대로 110' };

test('two photos give made-by-dotoriwiki\'s photo memo, byte for byte', async () => {
  const reqs: AttachmentRequest[] = [
    { n: 1, origin: 'gallery', place: '종로구 사직동', address: null },
    { n: 2, origin: 'camera', place: null, address: null },
  ];
  const m = memo(5, '친구랑 놀이터', { domain_hint: '일상', location: SEOUL, attachments: reqs });
  const attachments = [];
  for (const [i, original] of [GALAXY_JPEG, PLAIN_JPEG].entries()) {
    const b = bytes(original);
    attachments.push(attachmentOf({
      id: ulid(5) as MemoId,
      req: reqs[i]!,
      ext: sniffPhoto(b)!,
      sha256: createHash('sha256').update(b).digest('hex'),
      bytes: b.length,
      facts: photoFacts(await readExifTags(b), m.tz),
      memoFix: m.location,
    }));
  }
  const want = readFileSync(join(FIXTURE, '일상', 'raw', `${ulid(5)}.md`), 'utf8');
  assert.equal(renderMemoFile({ ...m, attachments }, { by: 'hint' }), want);
});
