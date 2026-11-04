// Copies exifr's full bundle into src/media/vendor with its one import() of Node's fs replaced,
// because Hermes cannot parse an import() whose specifier is a variable. Run: npm run vendor:exifr
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DYNAMIC_IMPORT = 'import(/* webpackIgnore: true */ e)';
export const REPLACEMENT = 'Promise.reject(new Error("exifr: no dynamic import on this runtime"))';

export function vendored(source: string): string {
  const parts = source.split(DYNAMIC_IMPORT);
  if (parts.length !== 2) throw new Error(`expected one dynamic import in exifr, found ${parts.length - 1}`);
  return parts.join(REPLACEMENT);
}

if (import.meta.url && process.argv[1] === fileURLToPath(import.meta.url)) {
  const from = fileURLToPath(new URL('../node_modules/exifr/dist/full.umd.js', import.meta.url));
  const to = fileURLToPath(new URL('../src/media/vendor/exifr.js', import.meta.url));
  writeFileSync(to, vendored(readFileSync(from, 'utf8')));
}
