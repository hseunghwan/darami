/**
 * When the runner may call the model, as pure transitions. dotoriwiki's loops.ts kept in meaning:
 * one global pause on unavailable, during which only jobs with no model run, and a per-domain
 * backoff after a failed attempt. Held in memory: a restart loses it, which costs at most one
 * request that answers with the same pause again.
 */

import type { DomainName } from '../core/types';
import type { Unavailable } from '../agent/model';
import type { RouteReport, RunReport } from './engine';

export type Schedule = {
  readonly pause: { readonly until: number; readonly cause: Unavailable['cause'] } | null;
  /** Epoch ms before which the domain runs no model job. */
  readonly backoff: ReadonlyMap<DomainName, number>;
  /** The domain that ran last, so the next round starts after it and no busy domain starves the others. */
  readonly last: DomainName | null;
};

export const START: Schedule = { pause: null, backoff: new Map(), last: null };

/** 30 s after a first failed attempt, then doubling: dotoriwiki's backoff. */
export const RETRY_BACKOFF_MS = 30_000;

/** `d` null asks for the router. */
export const modelAllowed = (s: Schedule, d: DomainName | null, now: number): boolean =>
  (!s.pause || now >= s.pause.until) && (d === null || now >= (s.backoff.get(d) ?? 0));

/** The later pause wins. */
function paused(s: Schedule, u: Unavailable, now: number): Schedule {
  const until = now + u.retryAfterMs;
  return s.pause && s.pause.until >= until ? s : { ...s, pause: { until, cause: u.cause } };
}

export const afterRoute = (s: Schedule, r: RouteReport, now: number): Schedule => (r.kind === 'unavailable' ? paused(s, r.unavailable, now) : s);

export function afterRun(s: Schedule, d: DomainName, r: RunReport, now: number): Schedule {
  if (r.kind === 'idle' || r.kind === 'paused' || r.kind === 'cancelled') return s;
  const ran = { ...s, last: d };
  if (r.kind === 'unavailable') return paused(ran, r.unavailable, now);
  const backoff = new Map(s.backoff);
  if (r.kind === 'retrying') backoff.set(d, now + RETRY_BACKOFF_MS * 2 ** (r.attempt - 1));
  else backoff.delete(d);
  return { ...ran, backoff };
}

/** The user logged in again: a login pause ends now. */
export const afterLogin = (s: Schedule): Schedule => (s.pause?.cause === 'login' ? { ...s, pause: null } : s);
/** The network came back: a network or server pause ends now. */
export const afterNetwork = (s: Schedule): Schedule => (s.pause?.cause === 'network' || s.pause?.cause === 'server' ? { ...s, pause: null } : s);

/** ms until the earliest pause or backoff still ahead ends, or null when nothing waits on time. */
export function wakeIn(s: Schedule, now: number): number | null {
  const ahead = [s.pause?.until ?? 0, ...s.backoff.values()].filter((t) => t > now);
  return ahead.length ? Math.min(...ahead) - now : null;
}

/** The declared domains starting after the one that ran last. */
export function rotation(s: Schedule, domains: readonly DomainName[]): readonly DomainName[] {
  const i = s.last === null ? -1 : domains.indexOf(s.last);
  return [...domains.slice(i + 1), ...domains.slice(0, i + 1)];
}
