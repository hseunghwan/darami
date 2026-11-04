import type { MemoSource } from '../core/pages';
import type { AttachmentRequest } from '../core/photos';
import type { DraftPhoto } from './photos';

/** The snake_case record core's parseMemo validates, so a typed or shared memo is checked by the code that reads a memo file. */
export type MemoRequest = {
  readonly id: string;
  readonly text: string;
  readonly captured_at: string;
  readonly tz: string;
  readonly location: GeoFix | null;
  readonly source: MemoSource;
  readonly domain_hint: string | null;
  readonly attachments: readonly AttachmentRequest[];
};

const pad = (n: number) => String(Math.trunc(Math.abs(n))).padStart(2, '0');

/** Local wall time with its offset, e.g. 2026-10-29T15:12:03+09:00. `offsetMinutes` is east of UTC. */
export function formatCapturedAt(at: Date, offsetMinutes: number): string {
  const local = new Date(at.getTime() + offsetMinutes * 60_000);
  const date = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
  const time = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
  const sign = offsetMinutes < 0 ? '-' : '+';
  return `${date}T${time}${sign}${pad(offsetMinutes / 60)}:${pad(offsetMinutes % 60)}`;
}

export function deviceTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof tz === 'string' && tz.includes('/')) return tz;
  } catch {}
  return 'Asia/Seoul';
}

/** `place` is shown in the app (구 and 동); `address` is only recorded (down to the 번지 or building). */
export type GeoFix = { lat: number; lon: number; place: string | null; address: string | null };

export type CaptureInput = {
  readonly id: string;
  readonly text: string;
  readonly at: Date;
  readonly source: MemoSource;
  readonly domainHint: string | null;
  readonly location: GeoFix | null;
  /** Photo n is photos[n - 1]. */
  readonly photos: readonly DraftPhoto[];
};

export function buildMemoRequest(input: CaptureInput): MemoRequest {
  return {
    id: input.id,
    text: input.text,
    captured_at: formatCapturedAt(input.at, -input.at.getTimezoneOffset()),
    tz: deviceTimeZone(),
    location: input.location,
    source: input.source,
    domain_hint: input.domainHint,
    attachments: input.photos.map((p, i) => ({ n: i + 1, origin: p.origin, place: p.place, address: p.address })),
  };
}
