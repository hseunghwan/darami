import assert from 'node:assert/strict';
import { parseMemoFile, renderMemoFile, type Memo } from '../pages';
import { fitWithin, jpegSize, photoFacts, photoLocation, sniffPhoto, takenAtOf, withEmbeds, withoutEmbeds, type Attachment } from '../photos';
import { memo, ulid } from './helpers';

const SEOUL = { lat: 37.5665, lon: 126.978, place: '중구 태평로1가', address: '서울특별시 중구 세종대로 110' };

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

test('taken_at: a missing offset tag takes the memo zone, a missing date is null, never the file time', () => {
  assert.equal(takenAtOf('2026:10:12 14:03:22', null, 'Asia/Seoul'), '2026-10-12T14:03:22+09:00');
  assert.equal(takenAtOf('2026:07:01 09:00:00', null, 'Europe/Paris'), '2026-07-01T09:00:00+02:00');
  assert.equal(takenAtOf('2026:10:12 14:03:22', '-05:00', 'Asia/Seoul'), '2026-10-12T14:03:22-05:00');
  assert.equal(takenAtOf('2026:10:12 14:03:22', '+9', 'Asia/Seoul'), '2026-10-12T14:03:22+09:00', 'an offset not in ±HH:MM is ignored');
  assert.equal(takenAtOf('0000:00:00 00:00:00', null, 'Asia/Seoul'), null);
  assert.equal(takenAtOf(null, '+09:00', 'Asia/Seoul'), null);
});

test('photo location: its own GPS, else the memo fix only for a camera shot taken just now', () => {
  const gps = { lat: 37.57591, lon: 126.96877 };
  const req = (origin: 'gallery' | 'camera' | 'share') => ({ n: 1, origin, place: '종로구 사직동', address: '서울특별시 종로구 사직동 1' });
  assert.deepEqual(photoLocation(gps, req('gallery'), SEOUL), { ...gps, place: '종로구 사직동', address: '서울특별시 종로구 사직동 1', from: 'exif' });
  assert.deepEqual(photoLocation(null, req('camera'), SEOUL), { ...SEOUL, from: 'device' });
  assert.equal(photoLocation(null, req('gallery'), SEOUL), null, 'an old gallery photo is not where the memo was written');
  assert.equal(photoLocation(null, req('share'), SEOUL), null);
  assert.equal(photoLocation(null, req('camera'), null), null);
});

test('sniffing trusts magic bytes only', () => {
  const b = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
  assert.equal(sniffPhoto(b('\xff\xd8\xff\xe0')), 'jpg');
  assert.equal(sniffPhoto(b('\x89PNG\r\n\x1a\n....')), 'png');
  assert.equal(sniffPhoto(b('RIFF\0\0\0\0WEBPVP8 ')), 'webp');
  assert.equal(sniffPhoto(b('\0\0\0\x18ftypheic\0\0\0\0')), 'heic');
  assert.equal(sniffPhoto(b('\0\0\0\x18ftypmif1\0\0\0\0')), 'heic');
  assert.equal(sniffPhoto(b('<html>')), null);
  assert.equal(sniffPhoto(new Uint8Array()), null);
});

test('photo facts from tags: sideways sizes swap, odd values drop to null, and an all-null group is null', () => {
  const f = photoFacts({ ExifImageWidth: 4032, ExifImageHeight: 3024, Orientation: 6, ISO: [50, 100], ExposureTime: 2.25, FNumber: 1.75, Flash: 25, Make: ' samsung\0\0', Model: '\0' }, 'Asia/Seoul');
  assert.deepEqual([f.width, f.height], [3024, 4032]);
  assert.deepEqual(f.camera, { exposure: '2.3s', fNumber: 1.8, iso: null, focal35mm: null, flash: true });
  assert.deepEqual(f.device, { make: 'samsung', model: null, lens: null, software: null });
  assert.equal(photoFacts({ ExposureTime: 0 }, 'Asia/Seoul').camera, null);
  assert.equal(photoFacts({ ExposureTime: 1 / 3 }, 'Asia/Seoul').camera?.exposure, '1/3');
  assert.deepEqual([photoFacts({ ExifImageWidth: 48 }, 'UTC').width, photoFacts({ ExifImageWidth: 48 }, 'UTC').height], [48, null]);
  assert.equal(photoFacts({ latitude: 0, longitude: 0 }, 'UTC').gps, null, '0,0 is no fix');
  assert.equal(photoFacts({ latitude: 91, longitude: 10 }, 'UTC').gps, null);
  assert.deepEqual(photoFacts({ latitude: -33.8688197, longitude: 151.2092955 }, 'UTC').gps, { lat: -33.86882, lon: 151.2093 });
  assert.deepEqual(photoFacts({}, 'UTC'), { width: null, height: null, takenAt: null, device: null, camera: null, gps: null });
});

test('a copy is never enlarged, and a larger one is brought to the cap on its long edge', () => {
  assert.equal(fitWithin(2048, 1536, 2048), null);
  assert.equal(fitWithin(64, 32, 2048), null);
  assert.deepEqual(fitWithin(4032, 3024, 2048), { width: 2048 });
  assert.deepEqual(fitWithin(3024, 4032, 2048), { height: 2048 });
  assert.deepEqual(fitWithin(3000, 3000, 1024), { width: 1024 });
});

test('jpegSize reads the SOF marker past other segments, and nothing from bytes that are not a JPEG', () => {
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  const app1 = [0xff, 0xe1, 0x00, 0x06, 0x45, 0x78, 0x69, 0x66];
  assert.deepEqual(jpegSize(Uint8Array.from([0xff, 0xd8, ...app1, ...sof, 0xff, 0xd9])), { width: 64, height: 32 });
  assert.equal(jpegSize(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9, 0, 0, 0, 0, 0, 0, 0])), null);
  assert.equal(jpegSize(Uint8Array.from('<html></html>', (c) => c.charCodeAt(0))), null);
});
