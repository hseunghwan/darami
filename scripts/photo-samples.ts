/**
 * Writes src/media/samples.gen.ts, the images darami://photo-check decodes on a device, or the
 * photo the emulator check sends. Run by hand on a Mac under Node 24, with sips and Homebrew's
 * cwebp on the PATH:
 *
 *   node --no-warnings scripts/photo-samples.ts
 *   node --no-warnings scripts/photo-samples.ts check <out.jpg>
 *
 * Every sample is stored with its left half red and its right half blue, so an upright copy of an
 * Orientation 6 sample is red on top.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const FIXTURE = join(ROOT, 'src', 'core', '__tests__', 'fixtures', 'made-by-dotoriwiki');
const ID5 = '01JB8ZQ4M3T9X7K2W5R6N8P005';
const { jpegWithExif } = await import(join(ROOT, 'src', 'media', '__tests__', 'exif-builder.ts'));

/** A 24-bit BMP, left half red and right half blue. */
function halves(width: number, height: number): Buffer {
  const row = Math.ceil((width * 3) / 4) * 4;
  const out = Buffer.alloc(54 + row * height);
  out.write('BM', 0, 'latin1');
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(row * height, 34);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = 54 + y * row + x * 3;
      // BGR.
      out.set(x < width / 2 ? [0, 0, 255] : [255, 0, 0], at);
    }
  }
  return out;
}

const dir = mkdtempSync(join(tmpdir(), 'darami-photo-samples-'));
const path = (name: string) => join(dir, name);
const sips = (format: string, from: string, to: string, ...extra: string[]) => {
  execFileSync('sips', ['-s', 'format', format, ...extra, from, '--out', path(to)], { stdio: 'ignore' });
  return readFileSync(path(to));
};

const [mode, out] = process.argv.slice(2);
try {
  if (mode === 'check') {
    if (!out) throw new Error('usage: node scripts/photo-samples.ts check <out.jpg>');
    writeFileSync(path('check.bmp'), halves(4032, 3024));
    const jpeg = jpegWithExif(
      {
        make: 'samsung', model: 'SM-S928N', orientation: 6, taken: '2026:11:05 10:00:00', offset: '+09:00',
        width: 4032, height: 3024, gps: { lat: 37.57591, lon: 126.96877 },
      },
      sips('jpeg', path('check.bmp'), 'check.jpg', '-s', 'formatOptions', '90'),
    );
    writeFileSync(out, jpeg);
    console.log(`wrote ${out} ${jpeg.length} bytes sha256 ${createHash('sha256').update(jpeg).digest('hex')}`);
  } else {
    writeFileSync(path('s.bmp'), halves(64, 32));
    const jpeg = sips('jpeg', path('s.bmp'), 's.jpg', '-s', 'formatOptions', '90');
    const png = sips('png', path('s.bmp'), 's.png');
    execFileSync('cwebp', ['-quiet', '-lossless', path('s.png'), '-o', path('s.webp')]);
    const samples = {
      orient1: jpegWithExif({ orientation: 1 }, jpeg),
      orient3: jpegWithExif({ orientation: 3 }, jpeg),
      orient6: jpegWithExif({ orientation: 6 }, jpeg),
      orient8: jpegWithExif({ orientation: 8 }, jpeg),
      png,
      webp: readFileSync(path('s.webp')),
      heic: sips('heic', path('s.jpg'), 's.heic'),
    };
    const b64 = (b: Buffer) => JSON.stringify(b.toString('base64'));
    const photo = (n: number) => b64(readFileSync(join(FIXTURE, '_attachments', `${ID5}-${n}.jpg`)));
    const text = [
      '// Written by scripts/photo-samples.ts. Do not edit.',
      '',
      '/** 64×32, left half red and right half blue, as stored. The JPEGs differ only in their Orientation tag. */',
      'export const SAMPLES = {',
      ...Object.entries(samples).map(([k, v]) => `  ${k}: ${b64(v)},`),
      '} as const;',
      '',
      "/** made-by-dotoriwiki's memo 5: its two photos and the memo file dotoriwiki wrote from them. */",
      'export const FIXTURE_MEMO = {',
      `  photos: [${photo(1)}, ${photo(2)}],`,
      `  file: ${JSON.stringify(readFileSync(join(FIXTURE, '일상', 'raw', `${ID5}.md`), 'utf8'))},`,
      '} as const;',
      '',
    ].join('\n');
    writeFileSync(join(ROOT, 'src', 'media', 'samples.gen.ts'), text);
    console.log(`wrote src/media/samples.gen.ts (${text.length} characters)`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
