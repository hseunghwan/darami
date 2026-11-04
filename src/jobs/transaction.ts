/**
 * A job's file transaction, and the only writer of <d>/wiki/log.md. git gave dotoriwiki atomic
 * commits and rollback; SAF gives neither, so two records in SQLite stand in for them:
 *
 *   1. Before a transaction first writes a path, the path's text (or "absent") is in the journal.
 *      Rollback writes those texts back, newest first.
 *   2. Before it writes log.md, the journal holds the exact text that write intends. A transaction
 *      is committed exactly when log.md starts with that text. Clearing the row is bookkeeping.
 *
 * Rows are keyed (domain, slot): slot `job` is runNext's job, so one live job per domain is a key;
 * slot `ledger` is one lone line (retry, moved). A row this process does not hold is stale: a kill,
 * or a throw that left it. Every log.md write runs in the domain's ledger lane, whose first step
 * settles the domain's stale rows, so no line lands on a torn ledger and recovery never races a live job.
 *
 * Settling a stale row R:
 *   log.md starts with R's intended text   committed: end R, the pages stay
 *   otherwise                              write every before-image back, log.md included if R kept it; then
 *     slot ledger, or R was abandoning      end R: the line, or the unavailable attempt, never happened
 *     slot job                              write `interrupted k/N | app stopped mid-job` (gave up N/N and the
 *                                           _review.md note at the max) through the same intend-then-write, end R
 * Every step can run again: a before-image is kept once, a restore writes the same text, and the
 * line is rebuilt from the restored ledger, so a kill inside recovery still ends with one line.
 */

import { appliedPages, failureOutcome, INTERRUPTED_REASON, withReviewNote } from '../core/filing';
import type { Fs, ReadFs } from '../core/fs';
import { paths, type WikiPath } from '../core/layout';
import { appendLine, parseLedger, type JobKind, type Ledger, type NewOutcome, type VerdictId } from '../core/ledger';
import { describeProblems, type Change, type Problem } from '../core/pages';
import type { Text } from '../core/text';
import type { DomainName, Locale } from '../core/types';
import { lanes } from './lanes';

export type Slot = 'job' | 'ledger';
export type JournalJob = { readonly kind: JobKind; readonly id: string; readonly attempt: number };

export type JournalHead = {
  readonly domain: DomainName;
  readonly slot: Slot;
  /** Slot `job` only. */
  readonly job: JournalJob | null;
  /** Set before an unavailable or cancelled job is rolled back: its recovery writes no line. */
  readonly abandoning: boolean;
  /** The exact log.md text the transaction's one log write intends; null until that write. */
  readonly intendedLog: string | null;
};

/** One wiki folder's journal: SQLite on the phone (sqlite.ts), memory under jest. Each method is one SQLite transaction and reads no files. */
export type JournalStore = {
  heads(): Promise<readonly JournalHead[]>;
  /** The row's before-images in the order they were kept. null: no file was there. */
  befores(domain: DomainName, slot: Slot): Promise<readonly (readonly [WikiPath, string | null])[]>;
  /** Throws when the row exists. */
  begin(domain: DomainName, slot: Slot, job: JournalJob | null): Promise<void>;
  /** The first image of a path wins, so a rerun never replaces it with a torn text. */
  before(domain: DomainName, slot: Slot, path: WikiPath, text: string | null): Promise<void>;
  intend(domain: DomainName, slot: Slot, logText: string): Promise<void>;
  abandon(domain: DomainName, slot: Slot): Promise<void>;
  /** Deletes the row and its before-images together. */
  end(domain: DomainName, slot: Slot): Promise<void>;
};

/** What a line needs from dotoriwiki.yaml, read when the line is written. */
export type Words = { readonly locale: Locale; readonly today: string; readonly t: Text };

export type Recovered = { readonly domain: DomainName; readonly slot: Slot; readonly job: JournalJob | null; readonly as: 'committed' | 'rolled-back' | 'interrupted' | 'gave-up' };

export type JournalDeps = {
  readonly fs: Fs;
  readonly store: JournalStore;
  /** null while dotoriwiki.yaml is broken: a row that needs a line waits. */
  readonly words: () => Promise<Words | null>;
  readonly onRecovered?: (r: Recovered) => void;
};

export type LineDraft = { readonly job: JobKind; readonly id: string; readonly outcome: NewOutcome };

export type JobTx = {
  readonly domain: DomainName;
  readonly job: JournalJob;
  write(path: WikiPath, text: string): Promise<void>;
  /** What the job changed under <d>/wiki/, index.md and log.md aside, from the journal: check()'s changes and contents. */
  changes(): { readonly changes: readonly Change[]; readonly contents: ReadonlyMap<string, string> };
  /** index.md, then the applied line listing the pages the job actually changed. */
  commit(verdict: VerdictId, index: string): Promise<void>;
  /** Rolls back, notes _review.md at the max, then writes `failed k/N` or `gave up N/N`. */
  fail(problems: readonly Problem[]): Promise<'retrying' | 'gave-up'>;
  /** Unavailable or cancelled: rolls back and writes no line, so no attempt is spent. */
  abandon(): Promise<void>;
  /** In runNext's finally: a job that neither committed, failed, nor abandoned is left stale for recovery. */
  release(): void;
};

export type Journal = {
  /** Settles the domain's stale rows, then opens its job row. */
  beginJob(domain: DomainName, job: JournalJob): Promise<JobTx>;
  /** One line outside a job. `make` sees the ledger inside the lane and answers null to write nothing. */
  appendLine(domain: DomainName, make: (ledger: Ledger) => LineDraft | null): Promise<boolean>;
  /** Settles stale rows, of one domain or of all. */
  recover(domain?: DomainName): Promise<void>;
  /** Ingest jobs the journal holds open, live or stale. */
  running(): Promise<ReadonlyMap<DomainName, string>>;
  /**
   * The folder as of the last commit, for readers outside every lane. A path a live transaction
   * wrote reads as it was before it, a file one made is absent from reads and listings, and every
   * other path reads through. Built with no method that writes. A row a kill or a throw left reads
   * through until recovery settles it.
   */
  committedFs(): ReadFs;
};

type Mem = {
  readonly domain: DomainName;
  readonly slot: Slot;
  readonly before: Map<WikiPath, string | null>;
  readonly wrote: Map<WikiPath, string>;
};

const keyOf = (domain: DomainName, slot: Slot) => `${domain}\0${slot}`;
const EMPTY_LOG = '# log\n';

export function openJournal(deps: JournalDeps): Journal {
  const { fs, store } = deps;
  const live = new Set<string>();
  const ledgerLane = lanes<DomainName>();
  /** The memories of live transactions: their before-images are what the folder held at the last commit. */
  const open = new Set<Mem>();

  function committed(): ReadonlyMap<WikiPath, string | null> {
    const out = new Map<WikiPath, string | null>();
    for (const m of open) for (const [path, b] of m.before) out.set(path, b);
    return out;
  }

  const inLedger = <T,>(d: DomainName, fn: () => Promise<T>): Promise<T> =>
    ledgerLane(d)(async () => {
      await recoverStale(d);
      return fn();
    });

  async function words(): Promise<Words> {
    const w = await deps.words();
    if (!w) throw new Error('dotoriwiki.yaml is broken, so no ledger line can be written');
    return w;
  }

  async function keep(mem: Mem, path: WikiPath): Promise<void> {
    if (mem.before.has(path)) return;
    const b = await fs.readText(path);
    await store.before(mem.domain, mem.slot, path, b);
    mem.before.set(path, b);
  }

  async function put(mem: Mem, path: WikiPath, text: string): Promise<void> {
    await keep(mem, path);
    await fs.write(path, text);
    mem.wrote.set(path, text);
  }

  /** Newest first, so a path kept twice under two spellings the storage folds into one ends at its oldest text. */
  async function restore(mem: Mem): Promise<void> {
    for (const [path, b] of [...mem.before].reverse()) {
      if ((await fs.readText(path)) === b) continue;
      if (b === null) await fs.remove(path);
      else await fs.write(path, b);
    }
    mem.wrote.clear();
  }

  /** Inside the domain's ledger lane only. */
  async function writeLine(mem: Mem, draft: LineDraft, w: Words): Promise<void> {
    const log = paths.log(mem.domain);
    await keep(mem, log);
    const intended = appendLine(w.locale, mem.before.get(log) ?? EMPTY_LOG, { date: w.today, ...draft });
    await store.intend(mem.domain, mem.slot, intended);
    await fs.write(log, intended);
  }

  async function reviewNote(mem: Mem, job: JournalJob, outcome: NewOutcome, w: Words): Promise<void> {
    if (outcome.kind !== 'gave-up') return;
    const review = paths.review(mem.domain);
    await put(mem, review, withReviewNote(await fs.readText(review), { date: w.today, job: job.kind, id: job.id, locale: w.locale, outcome }, w.t));
  }

  async function settle(h: JournalHead): Promise<void> {
    const mem: Mem = { domain: h.domain, slot: h.slot, before: new Map(await store.befores(h.domain, h.slot)), wrote: new Map() };
    const done = async (as: Recovered['as']) => {
      await store.end(h.domain, h.slot);
      deps.onRecovered?.({ domain: h.domain, slot: h.slot, job: h.job, as });
    };
    if (h.intendedLog !== null && (await fs.readText(paths.log(h.domain)))?.startsWith(h.intendedLog)) return done('committed');
    if (h.slot === 'ledger' || h.abandoning || !h.job) {
      await restore(mem);
      return done('rolled-back');
    }
    const w = await deps.words();
    if (!w) return;
    await restore(mem);
    const outcome = failureOutcome(h.job.attempt, INTERRUPTED_REASON, true);
    await reviewNote(mem, h.job, outcome, w);
    await writeLine(mem, { job: h.job.kind, id: h.job.id, outcome }, w);
    return done(outcome.kind === 'gave-up' ? 'gave-up' : 'interrupted');
  }

  async function recoverStale(d: DomainName): Promise<void> {
    const stale = (await store.heads()).filter((h) => h.domain === d && !live.has(keyOf(h.domain, h.slot)));
    // At most one row can have torn log.md, and it must be put back before another row reads it as a base.
    stale.sort((a, b) => Number(b.intendedLog !== null) - Number(a.intendedLog !== null));
    for (const h of stale) await settle(h);
  }

  return {
    async beginJob(domain, job) {
      const key = keyOf(domain, 'job');
      await inLedger(domain, async () => {
        await store.begin(domain, 'job', job);
        live.add(key);
      });
      const mem: Mem = { domain, slot: 'job', before: new Map(), wrote: new Map() };
      open.add(mem);
      let held = true;
      const release = () => {
        if (held) live.delete(key);
        held = false;
        open.delete(mem);
      };
      const close = async () => {
        await store.end(domain, 'job');
        release();
      };
      /** A throw inside the lane leaves the row stale at once, before the lane lets the next writer in. */
      const closing = (fn: () => Promise<void>) =>
        inLedger(domain, async () => {
          try {
            await fn();
            await close();
          } catch (e) {
            release();
            throw e;
          }
        });

      const changes = () => {
        const prefix = `${domain}/wiki/`;
        const server = new Set<string>([paths.index(domain), paths.log(domain)]);
        const out: Change[] = [];
        const contents = new Map<string, string>();
        for (const [path, b] of mem.before) {
          const now = mem.wrote.get(path);
          if (!path.startsWith(prefix) || server.has(path) || now === undefined || now === b) continue;
          out.push({ path, status: b === null ? 'added' : 'modified' });
          contents.set(path, now);
        }
        return { changes: out, contents };
      };

      return {
        domain,
        job,
        write: (path, text) => put(mem, path, text),
        changes,
        async commit(verdict, index) {
          await put(mem, paths.index(domain), index);
          const pages = appliedPages(domain, changes().changes);
          const w = await words();
          await closing(() => writeLine(mem, { job: job.kind, id: job.id, outcome: { kind: 'applied', verdict, pages } }, w));
        },
        async fail(problems) {
          await restore(mem);
          const w = await words();
          const outcome = failureOutcome(job.attempt, describeProblems(problems), false);
          await reviewNote(mem, job, outcome, w);
          await closing(() => writeLine(mem, { job: job.kind, id: job.id, outcome }, w));
          return outcome.kind === 'gave-up' ? 'gave-up' : 'retrying';
        },
        async abandon() {
          await store.abandon(domain, 'job');
          await restore(mem);
          await close();
        },
        release,
      };
    },

    appendLine(domain, make) {
      return inLedger(domain, async () => {
        const draft = make(parseLedger((await fs.readText(paths.log(domain))) ?? ''));
        if (!draft) return false;
        const w = await words();
        const key = keyOf(domain, 'ledger');
        await store.begin(domain, 'ledger', null);
        live.add(key);
        const mem: Mem = { domain, slot: 'ledger', before: new Map(), wrote: new Map() };
        open.add(mem);
        try {
          await writeLine(mem, draft, w);
          await store.end(domain, 'ledger');
        } finally {
          live.delete(key);
          open.delete(mem);
        }
        return true;
      });
    },

    async recover(domain) {
      const domains = domain ? [domain] : [...new Set((await store.heads()).map((h) => h.domain))];
      for (const d of domains) await inLedger(d, async () => undefined);
    },

    async running() {
      return new Map((await store.heads()).filter((h) => h.slot === 'job' && h.job?.kind === 'ingest').map((h) => [h.domain, h.job!.id] as const));
    },

    committedFs: () => ({
      async readText(path) {
        const c = committed();
        return c.has(path) ? c.get(path)! : fs.readText(path);
      },
      async list(dir) {
        const c = committed();
        return (await fs.list(dir)).filter((name) => c.get(`${dir === '' ? '' : `${dir}/`}${name}` as WikiPath) !== null);
      },
      async listTree(dir) {
        const c = committed();
        return (await fs.listTree(dir)).filter((path) => c.get(path) !== null);
      },
    }),
  };
}
