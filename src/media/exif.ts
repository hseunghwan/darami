/**
 * The one EXIF reader, for the record accept writes and for a draft photo's place. exifr 7.1.3 is
 * pinned to dotoriwiki's version and called with its options, so the tags are dotoriwiki's by
 * construction. Pure JS: jest and Hermes run this same file, so it is not a port and has no fake.
 */

import './navigator';
// exifr's full bundle with its import() of Node's fs removed, which Hermes cannot parse (scripts/vendor-exifr.ts).
import exifr from './vendor/exifr';
import type { ExifTags } from '../core/photos';

const OPTIONS = {
  tiff: true, exif: true, gps: true, ifd1: false, interop: false, xmp: false, icc: false, iptc: false, jfif: false, ihdr: false,
  reviveValues: false, translateValues: false, mergeOutput: true,
} as const;

/** {} when the bytes carry no EXIF or it does not parse: such a photo is still stored and shown, with no metadata. */
export async function readExifTags(bytes: Uint8Array): Promise<ExifTags> {
  try {
    const t: unknown = await exifr.parse(bytes, OPTIONS);
    return typeof t === 'object' && t !== null ? (t as ExifTags) : {};
  } catch {
    return {};
  }
}
