/**
 * Where a memo is and how far it got, derived from the names in the folder and each domain's
 * ledger. Pure: wiki.ts readPlaces gathers the snapshot, this module decides. dotoriwiki's state
 * table and locate(), with one change: `running` comes from the journal, not a .gateway marker.
 *
 *   inbox     inbox/<id>.md exists, and locate() finds nothing
 *   held      <d>/hold/<id>.md, and no live raw copy anywhere
 *   routed    <d>/raw/<id>.md, and <d>'s ledger has no terminal line for ingest:<id>
 *   running   routed, and the journal holds that ingest open
 *   ingested  terminal `applied`        failed  terminal `gave-up`        moved out  terminal `moved` (skipped)
 *
 * locate() reads names only, and a name can belong to a cut-off write, so a caller reads a copy back
 * whole before it deletes another copy because of it (jobs/memos.ts).
 */

import type { Ledger } from './ledger';
import { parseMemoId } from './pages';
import type { DomainName, MemoId } from './types';

export type MemoState = 'inbox' | 'held' | 'routed' | 'running' | 'ingested' | 'failed';

export type DomainPlaces = {
  readonly domain: DomainName;
  readonly raw: ReadonlySet<MemoId>;
  readonly hold: ReadonlySet<MemoId>;
  readonly ledger: Ledger;
};

/** One snapshot, domains in config order. */
export type Places = {
  readonly inbox: ReadonlySet<MemoId>;
  readonly domains: readonly DomainPlaces[];
  /** The ingest the journal holds open in each domain. */
  readonly running: ReadonlyMap<DomainName, string>;
};

export type Located = { readonly domain: DomainName; readonly state: Exclude<MemoState, 'inbox'> };

/**
 * A raw copy beats a hold copy. A domain the memo was moved out of is skipped, and a gave-up copy
 * loses to a live raw copy elsewhere, because that pair is a move cut off part way.
 */
export function locate(p: Places, id: MemoId): Located | null {
  let failed: DomainName | null = null;
  for (const d of p.domains) {
    if (!d.raw.has(id)) continue;
    const t = d.ledger.history('ingest', id).terminal?.kind;
    if (t === 'moved') continue;
    if (t === 'gave-up') failed ??= d.domain;
    else return { domain: d.domain, state: t === 'applied' ? 'ingested' : p.running.get(d.domain) === id ? 'running' : 'routed' };
  }
  if (failed) return { domain: failed, state: 'failed' };
  const held = p.domains.find((d) => d.hold.has(id));
  return held ? { domain: held.domain, state: 'held' } : null;
}

/** The memo ids filed as `<id>.md` among `names`: sidecars and stray names are skipped. */
export function memoIdsIn(names: readonly string[]): ReadonlySet<MemoId> {
  const out = new Set<MemoId>();
  for (const name of names) {
    const id = name.endsWith('.md') ? parseMemoId(name.slice(0, -3)) : null;
    if (id && `${id}.md` === name) out.add(id);
  }
  return out;
}

/** Oldest captured first, then by id: dotoriwiki's orderKey, so both apps pick the same memo next. */
export const orderKey = (iso: string, id: string): string => `${String(Date.parse(iso) || 0).padStart(16, '0')}\0${id}`;
