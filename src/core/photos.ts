/**
 * Photos on memos: how a photo's record sits in the memo file. Pure. Reading the record out of an
 * original's bytes, storing the bytes, and making the 2048 px copy come with P6.
 *
 *   _originals/<id>-<n>.<ext>    the bytes the phone sent
 *   _attachments/<id>-<n>.jpg    the copy pages embed with ![[...]]
 */

import type { Text } from './text';
import type { GeoPoint, MemoId, Parsed } from './types';

export const MAX_PHOTOS = 10;
export const PHOTO_ORIGINS = ['gallery', 'camera', 'share'] as const;
export type PhotoOrigin = (typeof PHOTO_ORIGINS)[number];

/** What the phone says about photo n: where it came from, and the geocoded name of its own GPS fix. */
export type AttachmentRequest = { readonly n: number; readonly origin: PhotoOrigin; readonly place: string | null; readonly address: string | null };

/** `from: device` is the memo's own fix, used for a camera photo that carried no GPS. */
export type PhotoLocation = GeoPoint & { readonly from: 'exif' | 'device' };
export type PhotoDevice = { readonly make: string | null; readonly model: string | null; readonly lens: string | null; readonly software: string | null };
export type PhotoCamera = {
  readonly exposure: string | null;
  readonly fNumber: number | null;
  readonly iso: number | null;
  readonly focal35mm: number | null;
  readonly flash: boolean | null;
};

/** One photo as recorded in the memo frontmatter. Everything but `origin` and the place names comes from the original's bytes. */
export type Attachment = {
  readonly file: string;
  readonly original: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly origin: PhotoOrigin;
  readonly takenAt: string | null;
  readonly location: PhotoLocation | null;
  readonly device: PhotoDevice | null;
  readonly camera: PhotoCamera | null;
};

export const photoStem = (id: MemoId, n: number) => `${id}-${n}`;
export const attachmentName = (id: MemoId, n: number) => `${photoStem(id, n)}.jpg`;

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic|avif)$/i;
export const isImageLink = (target: string) => IMAGE_EXT.test(target);

export function describeDevice(d: PhotoDevice | null): string | null {
  if (!d || (!d.make && !d.model)) return null;
  // Apple writes "Apple" / "iPhone 15"; Samsung writes "samsung" / "SM-S928N". Don't repeat a make the model already starts with.
  return d.make && d.model?.toLowerCase().startsWith(d.make.toLowerCase()) ? d.model : [d.make, d.model].filter(Boolean).join(' ');
}

/** One line per photo for the classifier and the ingest prompt: when, where, on what. */
export function describePhoto(a: Attachment, i: number, t: Text): string {
  const when = a.takenAt ? a.takenAt.slice(0, 16).replace('T', ' ') : null;
  const where = a.location ? (a.location.place ?? `${a.location.lat}, ${a.location.lon}`) : null;
  return t.photo(i + 1, [when, where, describeDevice(a.device)].filter((x): x is string => !!x));
}


export function renderAttachment(a: Attachment): Record<string, unknown> {
  const loc = a.location;
  return {
    file: a.file,
    original: a.original,
    sha256: a.sha256,
    bytes: a.bytes,
    width: a.width,
    height: a.height,
    origin: a.origin,
    taken_at: a.takenAt,
    location: loc ? { lat: loc.lat, lon: loc.lon, place: loc.place, address: loc.address, from: loc.from } : null,
    device: a.device,
    camera: a.camera && { exposure: a.camera.exposure, f_number: a.camera.fNumber, iso: a.camera.iso, focal_35mm: a.camera.focal35mm, flash: a.camera.flash },
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strOrNull = (v: unknown) => (typeof v === 'string' ? v : null);
const numOrNull = (v: unknown) => (typeof v === 'number' ? v : null);

/** The frontmatter list back. Only `file`, `original`, `sha256` and `origin` are required; the rest degrades to null. */
export function parseAttachments(v: unknown): Parsed<readonly Attachment[]> {
  if (v === undefined || v === null) return { ok: true, value: [] };
  if (!Array.isArray(v)) return { ok: false, detail: 'attachments: expected a list' };
  const out: Attachment[] = [];
  for (const [i, a] of v.entries()) {
    if (!isRecord(a) || typeof a.file !== 'string' || typeof a.original !== 'string' || typeof a.sha256 !== 'string' || !PHOTO_ORIGINS.includes(a.origin as PhotoOrigin)) {
      return { ok: false, detail: `attachments[${i}]: file, original, sha256, origin required` };
    }
    const l = a.location;
    const d = a.device;
    const c = a.camera;
    out.push({
      file: a.file,
      original: a.original,
      sha256: a.sha256,
      bytes: numOrNull(a.bytes) ?? 0,
      width: numOrNull(a.width),
      height: numOrNull(a.height),
      origin: a.origin as PhotoOrigin,
      takenAt: strOrNull(a.taken_at),
      location: isRecord(l) && typeof l.lat === 'number' && typeof l.lon === 'number'
        ? { lat: l.lat, lon: l.lon, place: strOrNull(l.place), address: strOrNull(l.address), from: l.from === 'device' ? 'device' : 'exif' }
        : null,
      device: isRecord(d) ? { make: strOrNull(d.make), model: strOrNull(d.model), lens: strOrNull(d.lens), software: strOrNull(d.software) } : null,
      camera: isRecord(c)
        ? { exposure: strOrNull(c.exposure), fNumber: numOrNull(c.f_number), iso: numOrNull(c.iso), focal35mm: numOrNull(c.focal_35mm), flash: typeof c.flash === 'boolean' ? c.flash : null }
        : null,
    });
  }
  return { ok: true, value: out };
}

/** The request list: n is 1..MAX_PHOTOS and unique. */
export function parseAttachmentRequests(v: unknown): Parsed<readonly AttachmentRequest[]> {
  if (v === undefined || v === null) return { ok: true, value: [] };
  if (!Array.isArray(v)) return { ok: false, detail: 'attachments: expected a list' };
  if (v.length > MAX_PHOTOS) return { ok: false, detail: `attachments: at most ${MAX_PHOTOS}` };
  const out: AttachmentRequest[] = [];
  for (const [i, a] of v.entries()) {
    if (!isRecord(a)) return { ok: false, detail: `attachments[${i}]: expected an object` };
    const { n, origin, place, address } = a;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_PHOTOS) return { ok: false, detail: `attachments[${i}].n: an integer from 1 to ${MAX_PHOTOS}` };
    if (out.some((x) => x.n === n)) return { ok: false, detail: `attachments[${i}].n: ${n} repeats` };
    if (!PHOTO_ORIGINS.includes(origin as PhotoOrigin)) return { ok: false, detail: `attachments[${i}].origin: one of ${PHOTO_ORIGINS.join(', ')}` };
    if (place !== undefined && place !== null && typeof place !== 'string') return { ok: false, detail: `attachments[${i}].place: expected a string` };
    if (address !== undefined && address !== null && typeof address !== 'string') return { ok: false, detail: `attachments[${i}].address: expected a string` };
    out.push({ n, origin: origin as PhotoOrigin, place: typeof place === 'string' ? place : null, address: typeof address === 'string' ? address : null });
  }
  return { ok: true, value: out };
}


const embed = (file: string) => `![[${file}]]`;

/** The memo body: the text, then one embed per photo, the way Obsidian lays out a pasted image. */
export function withEmbeds(text: string, attachments: readonly Attachment[]): string {
  if (!attachments.length) return text;
  const embeds = attachments.map((a) => embed(a.file)).join('\n');
  return text === '' ? embeds : `${text}\n\n${embeds}`;
}

/** Undoes withEmbeds: only a trailing run of exactly those embed lines is taken off. */
export function withoutEmbeds(body: string, attachments: readonly Attachment[]): string {
  if (!attachments.length) return body;
  const embeds = attachments.map((a) => embed(a.file)).join('\n');
  if (body === embeds) return '';
  return body.endsWith(`\n\n${embeds}`) ? body.slice(0, -(embeds.length + 2)) : body;
}
