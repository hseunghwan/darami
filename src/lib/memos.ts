import type { Verdict } from '../core/ledger';
import type { DomainName } from '../core/types';
import type { Finished, Placement } from '../jobs/engine';
import type { MemoState } from '../core/places';
import type { Filed } from '../state';
import { copy } from '../text';

export type Tone = 'wait' | 'route' | 'done' | 'warn' | 'bad';

/** Keyed by core's MemoState, so a state added there fails tsc here. */
export const STAGE: { readonly [S in MemoState]: { readonly label: string; readonly tone: Tone } } = {
  inbox: { label: copy.stage.inbox, tone: 'wait' },
  held: { label: copy.stage.held, tone: 'warn' },
  routed: { label: copy.stage.routed, tone: 'route' },
  running: { label: copy.stage.running, tone: 'route' },
  ingested: { label: copy.stage.ingested, tone: 'done' },
  failed: { label: copy.stage.failed, tone: 'bad' },
};

/** The engine's verdict in the phone's language, whatever language the wiki writes; text it never wrote comes back as written. */
export const verdictText = (v: Verdict): string => (typeof v === 'string' ? copy.verdict[v] : v.unknown);

/** The first page an ingest changed, under wiki/ without `.md`: the link a memo row shows. */
export const firstPage = (row: { readonly at: Placement }): string | null => (row.at.state === 'ingested' ? (row.at.pages[0]?.replace(/\.md$/, '') ?? null) : null);

const pad = (n: number) => String(n).padStart(2, '0');
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** 오후 3:12, 3:12 PM */
export const clock12 = (d: Date): string => copy.time.clock(d);

/** 15:12 */
export const clock24 = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export const monthDay = (d: Date): string => copy.time.monthDay(d);

/** Today, yesterday, or the date, in the phone's local time. */
export function dayLabel(d: Date, now: Date): string {
  if (sameDay(d, now)) return copy.time.today;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(d, yesterday)) return copy.time.yesterday;
  return d.getFullYear() === now.getFullYear() ? monthDay(d) : copy.time.otherYear(d);
}

/** When a job finished: the clock on the day it happened, the date and clock before, and only the date where the ledger's day is all there is. */
export function finishedText(f: Finished, now: Date): string {
  if ('at' in f) {
    const at = new Date(f.at);
    return sameDay(at, now) ? clock12(at) : copy.time.dateTime(at);
  }
  const [y, m, d] = f.day.split('-').map(Number);
  return y && m && d ? monthDay(new Date(y, m - 1, d)) : f.day;
}

/** What confirm or move answered, as the screens tell it. */
export type Released =
  | { readonly kind: 'released'; readonly domain: DomainName }
  | { readonly kind: 'gone' }
  /** It is no longer where the action needs it; `started`: filing began. */
  | { readonly kind: 'moved-on'; readonly started: boolean }
  | { readonly kind: 'no-domain' }
  | { readonly kind: 'paused' }
  | { readonly kind: 'failed'; readonly message: string };

export function releasedText(r: Exclude<Released, { kind: 'released' }>, action: 'confirm' | 'move'): string {
  switch (r.kind) {
    case 'gone':
      return copy.common.notFound;
    case 'moved-on':
      return action === 'confirm' ? copy.activity.stale : r.started ? copy.move.started : copy.move.wrongState;
    case 'no-domain':
      return copy.move.unknownDomain;
    case 'paused':
      return copy.move.paused;
    case 'failed':
      return action === 'confirm' ? copy.activity.confirmFailed : copy.move.failed;
  }
}

/** The 메모 tab's row time: just now, the clock today, the date and clock before. */
export function recentTime(d: Date, now: Date): string {
  if (now.getTime() - d.getTime() < 60_000) return copy.time.justNow;
  return sameDay(d, now) ? clock12(d) : copy.time.dateTime(d);
}

export type DayGroup<T> = { label: string; items: T[] };

/** Items arrive newest first by `when`, so groups come out in order without sorting. */
export function groupByDay<T>(items: readonly T[], now: Date, when: (item: T) => string): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const item of items) {
    const label = dayLabel(new Date(when(item)), now);
    const last = groups.at(-1);
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

/** Why a memo was not filed, in the memo tab's and the share sheet's notice. */
export function filedText(r: Exclude<Filed, { kind: 'filed' }>): string {
  switch (r.kind) {
    case 'no-wiki':
      return copy.filing.noWiki;
    case 'invalid':
      return copy.filing.invalid(r.detail);
    case 'failed':
      return copy.filing.notSaved;
    case 'photo-refused':
      return r.reason === 'missing' ? copy.filing.photoMissing(r.n) : r.reason === 'unsupported' ? copy.filing.photoUnsupported(r.n) : copy.filing.photoConflict;
  }
}
