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

import { failureOf, type MemoFailure } from './filing';
import type { Ledger, Verdict } from './ledger';
import { parseAnswerId, parseMemoId } from './pages';
import type { AnswerId, DomainName, MemoId } from './types';

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

/** When a job reached its terminal line: the clock time darami recorded at commit, or only the line's date. */
export type Finished = { readonly at: string } | { readonly day: string };

/** A memo as the screens show it: locate()'s answer with what its ledger says about it. */
export type Placement =
  | { readonly state: 'inbox' }
  | { readonly state: 'held'; readonly domain: DomainName }
  /** `retry`: earlier attempts failed since the latest retry line, and this is the next try. */
  | { readonly state: 'routed' | 'running'; readonly domain: DomainName; readonly retry: MemoFailure | null }
  /** `pages`: the applied line's fourth field, paths under wiki/ with `.md`. */
  | { readonly state: 'ingested'; readonly domain: DomainName; readonly verdict: Verdict; readonly pages: readonly string[]; readonly finished: Finished }
  | { readonly state: 'failed'; readonly domain: DomainName; readonly failure: MemoFailure; readonly finished: Finished };

/** null when the snapshot names no such memo, or names it only where it was moved out of. */
export function placementOf(p: Places, id: MemoId): Placement | null {
  const at = locate(p, id);
  if (!at) return p.inbox.has(id) ? { state: 'inbox' } : null;
  if (at.state === 'held') return { state: 'held', domain: at.domain };
  const ledger = p.domains.find((d) => d.domain === at.domain)!.ledger;
  const h = ledger.history('ingest', id);
  const finished = (line: number): Finished => ({ day: ledger.dateOf('ingest', id, line) ?? '' });
  if (h.terminal?.kind === 'applied') return { state: 'ingested', domain: at.domain, verdict: h.terminal.verdict, pages: h.terminal.pages, finished: finished(h.terminal.line) };
  if (h.terminal?.kind === 'gave-up') return { state: 'failed', domain: at.domain, failure: failureOf(h.terminal, h.terminal.attempt), finished: finished(h.terminal.line) };
  return { state: at.state === 'running' ? 'running' : 'routed', domain: at.domain, retry: h.attempts > 0 && h.lastFailure ? failureOf(h.lastFailure, h.attempts) : null };
}

/** Every memo id the snapshot names, in inbox/, raw/, or hold/. */
export function memoIds(p: Places): ReadonlySet<MemoId> {
  const out = new Set(p.inbox);
  for (const d of p.domains) {
    for (const id of d.raw) out.add(id);
    for (const id of d.hold) out.add(id);
  }
  return out;
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

/**
 * Where a saved chat answer is, derived like a memo's placement from names and a ledger:
 *   staged   inbox/answers/<d>/<id>.md, and <d>'s ledger has no terminal file-answer:<id>
 *   saved    terminal `applied`: `page` is the answer page under wiki/, without `.md`
 *   gave-up  terminal `gave-up`
 */
export type AnswerPlacement =
  | { readonly state: 'staged'; readonly domain: DomainName }
  | { readonly state: 'saved'; readonly domain: DomainName; readonly page: string }
  | { readonly state: 'gave-up'; readonly domain: DomainName; readonly failure: MemoFailure };

export type AnswerPlaces = readonly { readonly domain: DomainName; readonly staged: ReadonlySet<AnswerId>; readonly ledger: Ledger }[];

/** Every answer a domain's staging folder or ledger names. A terminal line wins over a staging copy a cut-off run left. */
export function answerPlacements(p: AnswerPlaces): ReadonlyMap<AnswerId, AnswerPlacement> {
  const out = new Map<AnswerId, AnswerPlacement>();
  for (const { domain, staged, ledger } of p) {
    const filed = ledger.ids('file-answer').flatMap((s) => parseAnswerId(s) ?? []);
    for (const id of new Set([...staged, ...filed])) {
      const t = ledger.history('file-answer', id).terminal;
      if (t?.kind === 'applied') out.set(id, { state: 'saved', domain, page: (t.pages[0] ?? '').replace(/\.md$/, '') });
      else if (t?.kind === 'gave-up') out.set(id, { state: 'gave-up', domain, failure: failureOf(t, t.attempt) });
      else if (staged.has(id)) out.set(id, { state: 'staged', domain });
    }
  }
  return out;
}

/** The answer ids staged as `<id>.md` among `names`. */
export function answerIdsIn(names: Iterable<string>): ReadonlySet<AnswerId> {
  const out = new Set<AnswerId>();
  for (const name of names) {
    const id = name.endsWith('.md') ? parseAnswerId(name.slice(0, -3)) : null;
    if (id && `${id}.md` === name) out.add(id);
  }
  return out;
}

/** Oldest captured first, then by id: dotoriwiki's orderKey, so both apps pick the same memo next. */
export const orderKey = (iso: string, id: string): string => `${String(Date.parse(iso) || 0).padStart(16, '0')}\0${id}`;
