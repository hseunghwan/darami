/** The fixture's photos and the EXIF builder over them. Not a test file. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jpegWithExif as build, type ExifSpec } from './exif-builder';

export { GALAXY, type ExifSpec } from './exif-builder';

const FIXTURE = join(__dirname, '..', '..', 'core', '__tests__', 'fixtures', 'made-by-dotoriwiki', '_attachments');
/** dotoriwiki's test/fixture/photos/plain.jpg, which made-by-dotoriwiki stored as photo 2 of memo 5. */
export const PLAIN_JPEG = readFileSync(join(FIXTURE, '01JB8ZQ4M3T9X7K2W5R6N8P005-2.jpg'));
/** jpegWithExif(GALAXY), photo 1 of memo 5. */
export const GALAXY_JPEG = readFileSync(join(FIXTURE, '01JB8ZQ4M3T9X7K2W5R6N8P005-1.jpg'));

export const jpegWithExif = (spec: ExifSpec, base: Uint8Array = PLAIN_JPEG): Buffer => build(spec, base);

/** Node's Buffer copied into jest's realm, where exifr's `instanceof Uint8Array` looks. */
export const bytes = (b: Buffer | Uint8Array): Uint8Array => new Uint8Array(b);
