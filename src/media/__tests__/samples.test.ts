import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jpegSize, sniffPhoto } from '../../core/photos';
import { readExifTags } from '../exif';
import { FIXTURE_MEMO, fixtureMemoFile, fromBase64, SAMPLES } from '../samples';

const FIXTURE = join(__dirname, '..', '..', 'core', '__tests__', 'fixtures', 'made-by-dotoriwiki');
const ID5 = '01JB8ZQ4M3T9X7K2W5R6N8P005';

test('the bundled fixture is made-by-dotoriwiki\'s memo 5 and its photos, byte for byte (else run scripts/photo-samples.ts)', () => {
  for (const n of [1, 2]) assert.equal(Buffer.from(fromBase64(FIXTURE_MEMO.photos[n - 1]!)).compare(readFileSync(join(FIXTURE, '_attachments', `${ID5}-${n}.jpg`))), 0, `photo ${n}`);
  assert.equal(FIXTURE_MEMO.file, readFileSync(join(FIXTURE, '일상', 'raw', `${ID5}.md`), 'utf8'));
});

test('the rebuild photo-check runs on a device gives the fixture memo under jest', async () => {
  assert.equal(await fixtureMemoFile(async (b) => createHash('sha256').update(b).digest('hex')), FIXTURE_MEMO.file);
});

test('the samples are 64×32 images of the types their names say, the JPEGs tagged with their orientation', async () => {
  const types = { orient1: 'jpg', orient3: 'jpg', orient6: 'jpg', orient8: 'jpg', png: 'png', webp: 'webp', heic: 'heic' } as const;
  for (const [name, b64] of Object.entries(SAMPLES)) assert.equal(sniffPhoto(fromBase64(b64)), types[name as keyof typeof types], name);
  for (const o of [1, 3, 6, 8] as const) {
    const b = fromBase64(SAMPLES[`orient${o}`]);
    assert.deepEqual(jpegSize(b), { width: 64, height: 32 }, `orient${o}`);
    assert.equal((await readExifTags(b)).Orientation, o, `orient${o}`);
  }
});
