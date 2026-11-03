import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { PRESET_SOURCE } from '../presets.gen';

const PRESETS = join(__dirname, '..', '..', '..', 'presets');

function onDisk(locale: string): Map<string, Buffer> {
  const dir = join(PRESETS, locale);
  return new Map(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => {
        const full = join(e.parentPath, e.name);
        return [relative(dir, full).split(sep).join('/').normalize('NFC'), readFileSync(full)] as const;
      }),
  );
}

test('presets.gen.ts holds every file of presets/, byte for byte, and nothing else (else run npm run presets)', () => {
  assert.deepEqual(Object.keys(PRESET_SOURCE).sort(), [...readdirSync(PRESETS)].sort());
  for (const [locale, generated] of Object.entries(PRESET_SOURCE)) {
    const disk = onDisk(locale);
    assert.deepEqual(Object.keys(generated).sort(), [...disk.keys()].sort(), locale);
    for (const [path, text] of Object.entries(generated)) {
      assert.ok(Buffer.from(text, 'utf8').equals(disk.get(path)!), `${locale}/${path}`);
    }
  }
});
