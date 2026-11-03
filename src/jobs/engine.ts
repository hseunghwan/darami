/**
 * The wiki engine on the phone: the one object that changes a wiki folder. dotoriwiki's WikiImpl
 * without git, the gateway, or the CLIs. Memo and job state is the folder and its ledgers, read
 * again by every call, so "after a restart" is just "the next call"; SQLite holds only the journal
 * a crash needs (transaction.ts).
 *
 * Outside src/jobs only this file, runner.ts, and sqlite.ts are imported (boundary.test.ts).
 *
 * Lanes, so no caller has to know them:
 *   memo      every move of a memo file: accept, a route's file effects, held, confirm, move. Short.
 *   router    one routeNext at a time. Its classify turns run outside the memo lane.
 *   job(d)    one runNext per domain. Long: model turns. No user action waits on it.
 *   ledger(d) inside transaction.ts: every log.md write and every recovery in d. Short.
 */

import { CONFIG_FILE, type ConfigParse, type ConfigProblem, type MachineFacts } from '../core/config';
import { dayIn } from '../core/filing';
import type { Fs } from '../core/fs';
import type { VerdictId } from '../core/ledger';
import type { NewMemo, Problem, Routing } from '../core/pages';
import type { Located } from '../core/places';
import { textFor } from '../core/text';
import type { DomainName, MemoId } from '../core/types';
import { readConfig } from '../core/wiki';
import { LIMITS, type AgentLimits } from '../agent/loop';
import type { Model, Unavailable } from '../agent/model';
import { domainJobs } from './domain';
import { lane, lanes, type Lane } from './lanes';
import { memoTransitions } from './memos';
import { openJournal, type Journal, type JournalStore, type Recovered, type Words } from './transaction';

export type JobRef = { readonly kind: 'ingest' | 'file-answer'; readonly domain: DomainName; readonly id: string };

export type AcceptResult =
  | { readonly kind: 'created' }
  | { readonly kind: 'duplicate'; readonly at: Located | 'inbox' }
  /** P3 files text memos; photos come with P6. */
  | { readonly kind: 'photos-unsupported' };

export type RouteReport =
  | { readonly kind: 'idle' }
  | { readonly kind: 'routed' | 'held'; readonly id: MemoId; readonly domain: DomainName; readonly routing: Routing }
  | { readonly kind: 'dropped-duplicate'; readonly id: MemoId }
  | { readonly kind: 'rejected'; readonly file: string; readonly reason: string }
  | { readonly kind: 'unavailable'; readonly unavailable: Unavailable }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'paused'; readonly problems: readonly ConfigProblem[] };

export type RunReport =
  | { readonly kind: 'idle' }
  | { readonly kind: 'committed'; readonly job: JobRef; readonly verdict: VerdictId }
  | { readonly kind: 'retrying'; readonly job: JobRef; readonly attempt: number; readonly problems: readonly Problem[] }
  | { readonly kind: 'gave-up'; readonly job: JobRef; readonly problems: readonly Problem[] }
  | { readonly kind: 'unavailable'; readonly job: JobRef; readonly unavailable: Unavailable }
  | { readonly kind: 'cancelled'; readonly job: JobRef }
  | { readonly kind: 'paused' };

/** What happens inside the engine that no call answers: a job starting, a stale journal row settled. */
export type EngineEvent =
  | { readonly kind: 'started'; readonly job: JobRef; readonly attempt: number }
  | ({ readonly kind: 'recovered' } & Recovered);

export type Engine = {
  /** Writes inbox/<id>.md and never calls the model. Sending the same id again changes nothing. */
  accept(memo: NewMemo): Promise<AcceptResult>;
  /** Routes the oldest inbox memo by its hint, the classifier, or the fallback, into raw/ or hold/. */
  routeNext(signal: AbortSignal): Promise<RouteReport>;
  /**
   * Runs the domain's next job as one transaction ending in exactly one ledger line, or none when
   * the model is unavailable or the run is cancelled. Answers first, then memos, oldest first.
   * `withModel: false` runs only jobs that need no model.
   */
  runNext(domain: DomainName, opts: { readonly withModel: boolean; readonly signal: AbortSignal }): Promise<RunReport>;
  locate(id: MemoId): Promise<Located | 'inbox' | null>;
  /** Declared domains in config order, or null while dotoriwiki.yaml or a CLAUDE.md it needs is broken or missing. */
  domains(): Promise<readonly DomainName[] | null>;
};

export type EngineDeps = {
  readonly fs: Fs;
  readonly journal: JournalStore;
  readonly model: Model;
  readonly machine: MachineFacts;
  readonly now: () => Date;
  readonly limits?: AgentLimits;
  readonly onEvent?: (e: EngineEvent) => void;
};

/** What memos.ts and domain.ts share. */
export type Ctx = {
  readonly fs: Fs;
  readonly model: Model;
  readonly now: () => Date;
  readonly limits: AgentLimits;
  readonly journal: Journal;
  /** The config rule: dotoriwiki.yaml read on every call, so an edit applies to the next one and a broken file pauses. */
  readonly config: () => Promise<ConfigParse>;
  readonly onEvent: (e: EngineEvent) => void;
  readonly memoLane: Lane;
  readonly router: Lane;
  readonly jobLane: (d: DomainName) => Lane;
};

const NO_CONFIG: ConfigParse = { ok: false, problems: [{ key: CONFIG_FILE, problem: 'does not exist', fix: 'restore it, or pick the wiki folder again' }] };

/**
 * Opens the engine, settles every stale journal row it can, and gives each declared domain the
 * log.md and index.md it lacks. Open one engine per folder per
 * process: two would each take the other's live job for stale. A row that needs a ledger line waits
 * while the config is broken, and the next runNext of its domain settles it.
 */
export async function openEngine(deps: EngineDeps): Promise<Engine> {
  const config = async () => (await readConfig(deps.fs, deps.machine)) ?? NO_CONFIG;
  const words = async (): Promise<Words | null> => {
    const c = await config();
    return c.ok ? { locale: c.config.locale, today: dayIn(c.config.timeZone, deps.now()), t: textFor(c.config.locale) } : null;
  };
  const onEvent = deps.onEvent ?? (() => {});
  const journal = openJournal({ fs: deps.fs, store: deps.journal, words, onRecovered: (r) => onEvent({ kind: 'recovered', ...r }) });
  const ctx: Ctx = {
    fs: deps.fs,
    model: deps.model,
    now: deps.now,
    limits: deps.limits ?? LIMITS,
    journal,
    config,
    onEvent,
    memoLane: lane(),
    router: lane(),
    jobLane: lanes<DomainName>(),
  };
  await journal.recover();
  const jobs = domainJobs(ctx);
  await jobs.init();
  return {
    ...memoTransitions(ctx),
    runNext: jobs.runNext,
    async domains() {
      const c = await config();
      return c.ok ? [...c.config.domains.keys()] : null;
    },
  };
}
