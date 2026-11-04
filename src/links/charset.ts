/**
 * HTML bytes to text by dotoriwiki's label rule: charset= in the Content-Type header, else
 * <meta … charset=> in the first 4 KB, else utf-8. Hermes's TextDecoder knows utf-8 and latin1
 * and throws for euc-kr, so the WHATWG EUC-KR and windows-1252 decoders are here in JS. Any other
 * label Hermes lacks is read as utf-8 only when the bytes are valid utf-8, which also covers a
 * misspelled label; otherwise the page is unsupported, because a sidecar holding mojibake is
 * never fetched again.
 */

import { EUC_KR_INDEX, WINDOWS_1252_HIGH } from './charset.gen';

export type Decoded = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'unsupported'; readonly label: string };

const UTF_8 = new Set(['unicode-1-1-utf-8', 'unicode11utf8', 'unicode20utf8', 'utf-8', 'utf8', 'x-unicode20utf8']);
const EUC_KR = new Set(['cseuckr', 'csksc56011987', 'euc-kr', 'iso-ir-149', 'korean', 'ks_c_5601-1987', 'ks_c_5601-1989', 'ksc5601', 'ksc_5601', 'windows-949']);
const WINDOWS_1252 = new Set([
  'ansi_x3.4-1968', 'ascii', 'cp1252', 'cp819', 'csisolatin1', 'ibm819', 'iso-8859-1', 'iso-ir-100', 'iso8859-1', 'iso88591', 'iso_8859-1', 'iso_8859-1:1987', 'l1', 'latin1', 'us-ascii', 'windows-1252', 'x-cp1252',
]);

/** The first 4 KB as latin1, by hand: the sniff trusts no decoder. */
const head = (b: Uint8Array) => String.fromCharCode(...b.subarray(0, 4096));

export function labelOf(contentType: string, bytes: Uint8Array): string {
  return (/charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head(bytes))?.[1] ?? 'utf-8').toLowerCase();
}

/** Chunked, so a 5 MB page never spreads millions of arguments into one call. */
function fromCodes(codes: Uint16Array, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 8192) out += String.fromCharCode(...codes.subarray(i, Math.min(length, i + 8192)));
  return out;
}

/** WHATWG's EUC-KR decoder: a lead 0x81–0xFE and a trail 0x41–0xFE name a pointer; an unmapped pair is U+FFFD, and an ASCII trail is read again. */
export function decodeEucKr(b: Uint8Array): string {
  const out = new Uint16Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    const lead = b[i]!;
    if (lead < 0x80) {
      out[n++] = lead;
      continue;
    }
    const trail = b[i + 1];
    if (lead === 0x80 || lead === 0xff || trail === undefined) {
      out[n++] = 0xfffd;
      continue;
    }
    const code = trail >= 0x41 && trail <= 0xfe ? EUC_KR_INDEX.charCodeAt((lead - 0x81) * 190 + (trail - 0x41)) : 0xfffd;
    out[n++] = code;
    if (code !== 0xfffd || trail >= 0x80) i++;
  }
  return fromCodes(out, n);
}

export function decodeWindows1252(b: Uint8Array): string {
  const out = new Uint16Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b[i]! >= 0x80 && b[i]! <= 0x9f ? WINDOWS_1252_HIGH.charCodeAt(b[i]! - 0x80) : b[i]!;
  return fromCodes(out, b.length);
}

/** Well-formed UTF-8 by RFC 3629: no overlong forms, surrogates, or code points past U+10FFFF. */
export function isUtf8(b: Uint8Array): boolean {
  for (let i = 0; i < b.length; ) {
    const c = b[i]!;
    const need = c < 0x80 ? 0 : c >= 0xc2 && c <= 0xdf ? 1 : c >= 0xe0 && c <= 0xef ? 2 : c >= 0xf0 && c <= 0xf4 ? 3 : -1;
    if (need < 0 || i + need >= b.length) return false;
    const second = b[i + 1] ?? 0;
    if (need >= 1) {
      const lo = c === 0xe0 ? 0xa0 : c === 0xf0 ? 0x90 : 0x80;
      const hi = c === 0xed ? 0x9f : c === 0xf4 ? 0x8f : 0xbf;
      if (second < lo || second > hi) return false;
      for (let k = 2; k <= need; k++) if ((b[i + k]! & 0xc0) !== 0x80) return false;
    }
    i += need + 1;
  }
  return true;
}

function hermesDecode(label: string, b: Uint8Array): string | null {
  try {
    return new TextDecoder(label).decode(b);
  } catch {
    return null;
  }
}

export function decodeHtml(contentType: string, bytes: Uint8Array): Decoded {
  const label = labelOf(contentType, bytes);
  if (UTF_8.has(label)) return { kind: 'text', text: new TextDecoder('utf-8').decode(bytes) };
  if (EUC_KR.has(label)) return { kind: 'text', text: decodeEucKr(bytes) };
  if (WINDOWS_1252.has(label)) return { kind: 'text', text: decodeWindows1252(bytes) };
  const text = hermesDecode(label, bytes) ?? (isUtf8(bytes) ? new TextDecoder('utf-8').decode(bytes) : null);
  return text === null ? { kind: 'unsupported', label } : { kind: 'text', text };
}
