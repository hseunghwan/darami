import assert from 'node:assert/strict';
import { parseMemoFile, renderMemoFile, type Memo } from '../pages';
import { withEmbeds, withoutEmbeds, type Attachment } from '../photos';
import { memo, ulid } from './helpers';

const attachment = (file: string): Attachment => ({
  file, original: file.replace('.jpg', '.heic'), sha256: 'ab', bytes: 1, width: null, height: null, origin: 'gallery', takenAt: null, location: null, device: null, camera: null,
});

test('embeds: appended after the text Obsidian-style, and only that trailing run is taken back off', () => {
  const as = [attachment('a-1.jpg'), attachment('a-2.jpg')];
  assert.equal(withEmbeds('놀이터', as), '놀이터\n\n![[a-1.jpg]]\n![[a-2.jpg]]');
  assert.equal(withEmbeds('', as), '![[a-1.jpg]]\n![[a-2.jpg]]');
  for (const text of ['놀이터', '', '본문에 ![[a-1.jpg]] 직접 적음', '끝\n\n![[a-1.jpg]]']) {
    assert.equal(withoutEmbeds(withEmbeds(text, as), as), text);
  }
});

test('the memo file round-trips its photos: frontmatter record, embeds in the body, typed text unchanged', () => {
  const m: Memo = { ...memo(1, '-'), text: '', attachments: [{ ...attachment(`${ulid(1)}-1.jpg`), takenAt: '2026-10-12T14:03:22+09:00', location: { lat: 1, lon: 2, place: 'p', address: null, from: 'exif' } }] };
  const file = renderMemoFile(m, null);
  assert.match(file, new RegExp(`\\n---\\n!\\[\\[${ulid(1)}-1\\.jpg\\]\\]\\n$`), 'a photo-only memo body is just the embed');
  assert.match(file, /taken_at: 2026-10-12T14:03:22\+09:00/);
  const back = parseMemoFile(file);
  assert.ok(back.ok);
  assert.equal(back.value.memo.text, '');
  assert.deepEqual(back.value.memo.attachments, m.attachments);
});
