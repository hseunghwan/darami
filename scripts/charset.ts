/**
 * Writes src/links/charset.gen.ts: the two decode tables Hermes lacks, for pages that declare
 * EUC-KR or windows-1252. Rerun under Node 24 after changing it:
 *
 *   npm run charset
 *
 * EUC-KR is WHATWG's, which is windows-949 (UHC): every lead 0x81–0xFE with every trail 0x41–0xFE,
 * as iconv-lite's cp949 decodes the pair. Node's own TextDecoder('euc-kr') is strict KS X 1001 and
 * maps only part of it. windows-1252 differs from latin1 only at 0x80–0x9F, from Node's decoder.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import iconv from 'iconv-lite';

const ROOT = join(import.meta.dirname, '..');

let index = '';
let mapped = 0;
for (let lead = 0x81; lead <= 0xfe; lead++) {
  for (let trail = 0x41; trail <= 0xfe; trail++) {
    const s = iconv.decode(Buffer.from([lead, trail]), 'cp949');
    const ok = s.length === 1 && s !== '�';
    index += ok ? s : '�';
    if (ok) mapped++;
  }
}
const high = new TextDecoder('windows-1252').decode(Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i));

/** A string literal with control characters escaped, so the file shows every code unit it holds. */
const literal = (v: string) => `"${v.replace(/[\\"\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (c) => (c === '\\' || c === '"' ? `\\${c}` : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`))}"`;

const text = [
  '// Written by scripts/charset.ts. Do not edit.',
  '',
  `/** WHATWG's index-euc-kr: pointer (lead − 0x81) × 190 + (trail − 0x41) to its code unit, U+FFFD where none. ${mapped} of ${index.length} mapped. */`,
  `export const EUC_KR_INDEX = ${literal(index)};`,
  '',
  '/** windows-1252 at 0x80–0x9F; every other byte is its own code point. */',
  `export const WINDOWS_1252_HIGH = ${literal(high)};`,
  '',
].join('\n');
writeFileSync(join(ROOT, 'src', 'links', 'charset.gen.ts'), text);
console.log(`wrote src/links/charset.gen.ts: ${mapped} of ${index.length} EUC-KR pointers mapped`);
