/**
 * What `tsc -p tsconfig.app.json` cannot see. That program has no ambient types, so Buffer and
 * node:* already fail in every file the phone ships. These rules read the source text instead.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

/** The packages a file loads, through every relative import it makes, at any depth. */
function packagesLoadedBy(path: string, byPath: ReadonlyMap<string, Source>): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  const walk = (p: string) => {
    if (seen.has(p)) return;
    seen.add(p);
    const s = byPath.get(p) ?? byPath.get(join(p, 'index'));
    if (!s) return;
    for (const i of s.imports) {
      if (i.to === null) out.add(i.spec);
      else walk(i.to);
    }
  };
  walk(withoutExt(path));
  return out;
}

test('src/agent and src/jobs load under jest: no expo or react-native, at any depth, outside the two files that bind the phone', () => {
  const all = sources(SRC);
  const byPath = new Map(all.map((s) => [withoutExt(s.path), s]));
  const bound = new Set([join(SRC, 'agent', 'codex.ts'), join(SRC, 'jobs', 'sqlite.ts')]);
  const engine = ['agent', 'jobs'].map((d) => join(SRC, d)).filter(existsSync).flatMap((d) => sources(d)).filter((s) => !bound.has(s.path));
  assert.ok(engine.some((s) => name(s.path) === join('jobs', 'transaction.ts')), 'the scan sees the jobs');
  const leaks = engine.flatMap((s) => [...packagesLoadedBy(s.path, byPath)].filter((p) => /^(expo|react-native|react$)/.test(p)).map((p) => `${name(s.path)}: ${p}`));
  assert.deepEqual(leaks, []);
});

test('src/agent reaches files only through a Workspace: it imports no Fs, no folder reader, and nothing from src/jobs', () => {
  const agent = sources(join(SRC, 'agent'));
  assert.ok(agent.some((s) => name(s.path) === join('agent', 'loop.ts')), 'the scan sees the loop');
  const banned = (to: string) => to.startsWith(join(SRC, 'fs') + '/') || to.startsWith(join(SRC, 'jobs') + '/') || to === join(CORE, 'fs') || to === join(CORE, 'wiki');
  const leaks = agent.flatMap((s) => s.imports.filter((i) => i.to !== null && banned(i.to)).map((i) => `${name(s.path)}: ${i.spec}`));
  assert.deepEqual(leaks, []);
});

test('only jobs/transaction.ts writes or removes a log.md', () => {
  const engine = ['agent', 'jobs'].flatMap((d) => sources(join(SRC, d)));
  assert.ok(engine.some((s) => name(s.path) === join('jobs', 'transaction.ts')), 'the scan sees the journal');
  const writers = engine.filter((s) => /\.(write|remove)\(\s*paths\.log\(/.test(s.text) || /\.(write|remove)\(\s*log\b/.test(s.text)).map((s) => name(s.path));
  assert.deepEqual(writers, [join('jobs', 'transaction.ts')]);
});

test('outside src/jobs, only the engine, the runner, and the SQLite store are imported', () => {
  const jobs = join(SRC, 'jobs');
  const open = new Set(['engine', 'runner', 'sqlite'].map((f) => join(jobs, f)));
  const outside = sources(SRC).filter((s) => !s.path.startsWith(jobs + '/'));
  assert.ok(outside.some((s) => name(s.path) === 'state.ts'), 'the scan sees the app');
  const leaks = outside.flatMap((s) => s.imports.filter((i) => i.to !== null && i.to.startsWith(jobs + '/') && !open.has(i.to)).map((i) => `${name(s.path)}: ${i.spec}`));
  assert.deepEqual(leaks, []);
});
