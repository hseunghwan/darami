import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { parseWikiPath, type WikiPath } from '../layout';
import { presetFiles, unfinishedPreset, withZone } from '../presets';
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

test('presetFiles writes gitignore as .gitignore, every path a WikiPath, sorted, dotoriwiki.yaml last', () => {
  for (const locale of ['ko', 'en'] as const) {
    const files = presetFiles(locale, undefined).map((f) => f.path);
    assert.equal(files.length, Object.keys(PRESET_SOURCE[locale]).length, locale);
    assert.ok(files.includes('.gitignore' as WikiPath) && !files.includes('gitignore' as WikiPath), locale);
    assert.equal(files.at(-1), 'dotoriwiki.yaml', locale);
    const rest = files.slice(0, -1);
    assert.deepEqual(rest, [...rest].sort(), locale);
    for (const p of files) assert.equal(parseWikiPath(p), p, p);
  }
});

test('withZone sets a zone Intl knows and keeps the preset zone otherwise', () => {
  const preset = PRESET_SOURCE.ko['dotoriwiki.yaml'];
  for (const zone of ['GMT', 'Asia/Seoul', 'America/Chicago']) {
    const text = withZone(preset, zone);
    const changed = text.split('\n').filter((l, i) => l !== preset.split('\n')[i]);
    assert.deepEqual(changed, zone === 'Asia/Seoul' ? [] : [`time_zone: ${zone}`], zone);
  }
  for (const zone of [undefined, '', 'Not/AZone', 'Asia/Seoul\nlocale: en']) assert.equal(withZone(preset, zone), preset, JSON.stringify(zone));
});

test('unfinishedPreset names the preset whose root names a cut-off copy fits, preferring the phone locale on a tie', () => {
  assert.equal(unfinishedPreset(['CLAUDE.md', 'inbox'], 'en'), 'en');
  assert.equal(unfinishedPreset(['CLAUDE.md', 'inbox'], 'ko'), 'ko');
  assert.equal(unfinishedPreset(['_schema', '스터디'], 'en'), 'ko');
  assert.equal(unfinishedPreset(['journal', 'dotoriwiki.yaml'], 'ko'), 'en');
  assert.equal(unfinishedPreset(['스터디', 'journal'], 'ko'), null);
  assert.equal(unfinishedPreset(['notes.md'], 'ko'), null);
});
