import assert from 'node:assert/strict';
import { photoFacts } from '../../core/photos';
import { readExifTags } from '../exif';
import { bytes, GALAXY, jpegWithExif, PLAIN_JPEG } from './exif';

const factsOf = async (b: Buffer, tz = 'Asia/Seoul') => photoFacts(await readExifTags(bytes(b)), tz);

test('photo facts: when, where and on what, read from the bytes with the date left in its own offset', async () => {
  const f = await factsOf(jpegWithExif(GALAXY));
  assert.equal(f.takenAt, '2026-10-12T14:03:22+09:00');
  assert.deepEqual(f.gps, { lat: 37.57591, lon: 126.96877 });
  assert.deepEqual(f.device, { make: 'samsung', model: 'SM-S928N', lens: 'Galaxy S24 Ultra Rear Wide Camera', software: 'S928NXXU1AXA1' });
  assert.deepEqual(f.camera, { exposure: '1/120', fNumber: 1.7, iso: 50, focal35mm: 23, flash: false });

  const bare = await factsOf(PLAIN_JPEG);
  assert.deepEqual([bare.takenAt, bare.gps, bare.device, bare.camera], [null, null, null, null], 'a photo without EXIF has no metadata, not made-up metadata');
  assert.deepEqual(await readExifTags(Uint8Array.from([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e])), {}, 'garbage does not throw');
});

test('sideways sizes swap, an ISO of several values is null, and a southern or western fix keeps its sign', async () => {
  const f = await factsOf(jpegWithExif({ orientation: 6, width: 4032, height: 3024, iso: [50, 64], gps: { lat: -33.86882, lon: -70.6483 } }, Buffer.from([0xff, 0xd8, 0xff, 0xd9])));
  assert.deepEqual([f.width, f.height], [3024, 4032]);
  assert.equal(f.camera, null, 'an ISO written as two shorts is no ISO');
  assert.deepEqual(f.gps, { lat: -33.86882, lon: -70.6483 });
  const upright = await factsOf(jpegWithExif({ orientation: 3, width: 4032, height: 3024 }, Buffer.from([0xff, 0xd8, 0xff, 0xd9])));
  assert.deepEqual([upright.width, upright.height], [4032, 3024]);
});

test('only the first Exif segment counts, as dotoriwiki read photo 1 of its fixture', async () => {
  const f = await factsOf(jpegWithExif(GALAXY));
  assert.deepEqual([f.width, f.height], [null, null], 'plain.jpg\'s own 48×48 sits in the second APP1');
  assert.deepEqual([(await factsOf(PLAIN_JPEG)).width, (await factsOf(PLAIN_JPEG)).height], [48, 48]);
});
