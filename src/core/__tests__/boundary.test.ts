/**
 * What `tsc -p tsconfig.app.json` cannot see. That program has no ambient types, so Buffer and
 * node:* already fail in every file the phone ships. These rules read the source text instead.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const SRC = resolve(__dirname, '..', '..');
const CORE = join(SRC, 'core');
const PACKAGES = ['yaml'];
const FORBIDDEN = [/\bimport\.meta\b/, /\brequire\(/, /\bprocess\./];

type Source = { readonly path: string; readonly text: string; readonly imports: readonly { readonly spec: string; readonly to: string | null }[] };

const withoutExt = (p: string) => p.replace(/\.tsx?$/, '');

/**
 * Every .ts and .tsx file under dir that is not a test. `to` is the extensionless target of a relative import.
 * The listing is copied into this realm's Array: assert's strict deepEqual tells jest's Array from Node's.
 */
function sources(dir: string): Source[] {
  return [...readdirSync(dir, { recursive: true, encoding: 'utf8' })]
    .filter((f) => /\.tsx?$/.test(f) && !f.split(/[\\/]/).includes('__tests__'))
    .map((f) => {
      const path = join(dir, f);
      const text = readFileSync(path, 'utf8');
      const imports = [...text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g)].map((m) => {
        const spec = m[1]!;
        return { spec, to: spec.startsWith('.') ? withoutExt(resolve(dirname(path), spec)) : null };
      });
      return { path, text, imports };
    });
}

const name = (path: string) => relative(SRC, path);

test('core imports only its own modules and yaml', () => {
  const core = sources(CORE);
  assert.ok(core.some((s) => name(s.path) === join('core', 'ledger.ts')), 'the scan sees the engine');
  const leaks = core.flatMap((s) =>
    s.imports.filter((i) => (i.to === null ? !PACKAGES.includes(i.spec) : !i.to.startsWith(`${CORE}/`))).map((i) => `${name(s.path)}: ${i.spec}`),
  );
  assert.deepEqual(leaks, []);
});

test('core uses no import.meta, require, or process', () => {
  const core = sources(CORE);
  assert.ok(core.length > 0, 'the scan sees the engine');
  const hits = core.flatMap((s) => FORBIDDEN.filter((re) => re.test(s.text)).map((re) => `${name(s.path)}: ${re.source}`));
  assert.deepEqual(hits, []);
});

test('only wiki.ts imports the Fs port', () => {
  const core = sources(CORE);
  assert.ok(core.length > 0, 'the scan sees the engine');
  const fs = join(CORE, 'fs');
  const leaks = core.filter((s) => s.path !== join(CORE, 'wiki.ts') && s.imports.some((i) => i.to === fs)).map((s) => name(s.path));
  assert.deepEqual(leaks, []);
});

test('no file outside src/fs imports the node adapter, tests aside', () => {
  const outside = sources(SRC).filter((s) => !s.path.startsWith(join(SRC, 'fs') + '/'));
  assert.ok(outside.some((s) => name(s.path) === join('core', 'ledger.ts')), 'the scan sees the app and the engine');
  const node = join(SRC, 'fs', 'node');
  const leaks = outside.filter((s) => s.imports.some((i) => i.to === node)).map((s) => name(s.path));
  assert.deepEqual(leaks, []);
});
