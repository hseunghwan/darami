/**
 * The wiki engine on the phone: the one object that changes a wiki folder. dotoriwiki's WikiImpl
 * without git, the gateway, or the CLIs. Memo and job state is the folder and its ledgers, read
 * again by every call, so "after a restart" is just "the next call"; SQLite holds the journal a
 * crash needs (transaction.ts) and the memo book's immutable facts (book.ts).
 *
 * The engine sees its Fs and JournalStore only through the book, so the screens' read model is
 * fed by the engine's own reads and writes and never lists the folder on its own. The one
 * exception to "read again by every call": inside a runner pass, a memo folder or ledger read once
 * is answered from the book, so an idle pass lists each memo folder once.
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
import type { NewMemo, PageRef, Problem, Routing } from '../core/pages';
import type { PhotoTools } from '../core/photos';
import type { Located } from '../core/places';
import { textFor } from '../core/text';
import type { DomainName, MemoId } from '../core/types';
import { readConfig, readPlaces } from '../core/wiki';
import { LIMITS, type AgentLimits, type ChatLimits } from '../agent/loop';
import type { Model, Unavailable } from '../agent/model';
import { openBook, type Book, type BookParts, type BookStore, type Pass } from './book';
import { chatService, type Chats, type ChatStore, type PageView, type TurnRef } from './chat';
import { domainJobs, type SaveResult } from './domain';
import { lane, lanes, type Lane } from './lanes';
import { memoTransitions } from './memos';
import { photoFiles, type PendingPhotos, type PhotoFiles, type PhotoRefusal } from './photos';
import { openJournal, type Journal, type JournalStore, type Recovered, type Words } from './transaction';

export type { Book, BookStore, ChangedPage, CommitRecord, FailedRow, HeldRow, MemoBook, MemoDetail, MemoHeader, MemoRow, Pass } from './book';
export type { AnsweredTurn, AskResult, AskTrace, ChatFailure, ChatStore, ChatSummary, ChatTurn, ChatView, FailedTurn, PageView, Question, TurnRef } from './chat';
export type { SaveRefusal, SaveResult } from './domain';
export type { ChatProgress } from '../agent/loop';
export type { AnswerPlacement } from '../core/places';
export type { Finished, Placement } from '../core/places';
export type { FailureCode, MemoFailure } from '../core/filing';
export type { PendingPhotos, PhotoRefusal } from './photos';

export type JobRef = { readonly kind: 'ingest' | 'file-answer'; readonly domain: DomainName; readonly id: string };

export type AcceptResult =
  | { readonly kind: 'created' }
  | { readonly kind: 'duplicate'; readonly at: Located | 'inbox' }
  | PhotoRefusal;

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

export type ReleaseResult =
  | { readonly kind: 'released'; readonly domain: DomainName }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'conflict'; readonly at: Located }
  | { readonly kind: 'paused' };

/** What happens inside the engine that no call answers: a job starting, a stale journal row settled. */
export type EngineEvent =
  | { readonly kind: 'started'; readonly job: JobRef; readonly attempt: number }
  | ({ readonly kind: 'recovered' } & Recovered);

export type Engine = {
  /**
   * Writes the memo's photos, then inbox/<id>.md, and never calls the model. Each photo's original
   * and copy go first, one photo at a time, and the memo file last, so a memo never names a photo
   * that is not stored. Sending the same id again changes nothing; after a kill it writes only what
   * is missing and finishes what was cut off. A memo the book already locates past the inbox is a
   * duplicate before any photo is read. `pending` reads photo n from the phone; without it every
   * original must already be stored.
   */
  accept(memo: NewMemo, pending?: PendingPhotos): Promise<AcceptResult>;
  /** Routes the oldest inbox memo by its hint, the classifier, or the fallback, into raw/ or hold/. */
  routeNext(signal: AbortSignal, pass?: Pass): Promise<RouteReport>;
  /**
   * Runs the domain's next job as one transaction ending in exactly one ledger line, or none when
   * the model is unavailable or the run is cancelled. Answers first, then memos, oldest first.
   * `withModel: false` runs only jobs that need no model.
   */
  runNext(domain: DomainName, opts: { readonly withModel: boolean; readonly signal: AbortSignal; readonly pass?: Pass }): Promise<RunReport>;
  /** A runner pass: routeNext and runNext given it read each memo folder and ledger once in it. */
  pass(): Pass;
  /** A held memo into its domain's raw/, byte for byte. */
  confirm(id: MemoId): Promise<ReleaseResult>;
  /** A held or gave-up memo into another domain, with routing `by: user`. Never an ingested one. */
  move(id: MemoId, to: DomainName): Promise<ReleaseResult>;
  /** A retry line for a gave-up ingest, unless the memo was moved on. */
  retry(domain: DomainName, id: MemoId): Promise<'retrying' | 'not-failed'>;
  /** Declared domains in config order, or null while dotoriwiki.yaml or a CLAUDE.md it needs is broken or missing. */
  domains(): Promise<readonly DomainName[] | null>;
  /** The memos as the screens show them, kept by the engine's own reads and writes. */
  readonly book: Book;
  /** Chat with the wiki: ask, list, open, remove. Reads the folder as of the last commit and writes none of it. */
  readonly chats: Chats;
  /** A wiki page for the page viewer, as of the last commit. null when there is no such page. */
  page(ref: PageRef): Promise<PageView | null>;
  /**
   * Stages a stored answer for its domain's file-answer job, after checking every link its page
   * would carry against the committed folder. The same turn again is a duplicate. Writes only
   * inbox/answers/<d>/<id>.md; the job writes the page and the ledger line.
   */
  saveAnswer(turn: TurnRef): Promise<SaveResult>;
};

export type EngineDeps = {
  readonly fs: Fs;
  readonly journal: JournalStore;
  /** sqliteBook(folder) on the phone, memoryBook() under jest. */
  readonly book: BookStore;
  readonly model: Model;
  readonly machine: MachineFacts;
  readonly now: () => Date;
  readonly limits?: AgentLimits;
  /** sqliteChats(folder) on the phone, memoryChats() under jest. */
  readonly chats: ChatStore;
  readonly chatLimits?: ChatLimits;
  readonly onEvent?: (e: EngineEvent) => void;
  /** phonePhotoTools on the phone, copyingTools() under jest. */
  readonly photos: PhotoTools;
};

/** What memos.ts and domain.ts share. `fs` is the book's, so every read and write reaches the book. */
export type Ctx = {
  readonly fs: Fs;
  readonly book: BookParts;
  readonly model: Model;
  readonly now: () => Date;
  readonly limits: AgentLimits;
  readonly journal: Journal;
  /** The config rule: dotoriwiki.yaml read on every call, so an edit applies to the next one and a broken file pauses. */
  readonly config: () => Promise<ConfigParse>;
  readonly onEvent: (e: EngineEvent) => void;
  readonly memoLane: Lane;
  /** Accepts' photo writes, one memo at a time, outside the memo lane: a copy takes about a second and touches no memo file. */
  readonly photoLane: Lane;
  readonly router: Lane;
  readonly jobLane: (d: DomainName) => Lane;
  readonly photos: PhotoFiles;
};

const NO_CONFIG: ConfigParse = { ok: false, problems: [{ key: CONFIG_FILE, problem: 'does not exist', fix: 'restore it, or pick the wiki folder again' }] };

/**
 * Opens the engine, settles every stale journal row it can, and gives each declared domain the
 * log.md and index.md it lacks. Open one engine per folder per
 * process: two would each take the other's live job for stale. A row that needs a ledger line waits
 * while the config is broken, and the next runNext of its domain settles it.
 */
export async function openEngine(deps: EngineDeps): Promise<Engine> {
  const book = await openBook({ fs: deps.fs, journal: deps.journal, store: deps.book, now: deps.now });
  const config = async () => {
    const c = (await readConfig(book.fs, deps.machine)) ?? NO_CONFIG;
    book.sawConfig(c);
    return c;
  };
  const words = async (): Promise<Words | null> => {
    const c = await config();
    return c.ok ? { locale: c.config.locale, today: dayIn(c.config.timeZone, deps.now()), t: textFor(c.config.locale) } : null;
  };
  const onEvent = deps.onEvent ?? (() => {});
  const journal = openJournal({ fs: book.fs, store: book.journal, words, onRecovered: (r) => onEvent({ kind: 'recovered', ...r }) });
  const photos = photoFiles({
    fs: book.fs,
    tools: deps.photos,
    writes: deps.book,
    now: deps.now,
    places: async () => {
      const c = await config();
      return c.ok ? readPlaces(book.fs, c.config, await journal.running()) : null;
    },
  });
  const ctx: Ctx = {
    fs: book.fs,
    book,
    model: deps.model,
    now: deps.now,
    limits: deps.limits ?? LIMITS,
    journal,
    config,
    onEvent,
    memoLane: lane(),
    photoLane: lane(),
    router: lane(),
    jobLane: lanes<DomainName>(),
    photos,
  };
  await journal.recover();
  await photos.sweep();
  const memos = memoTransitions(ctx);
  const jobs = domainJobs(ctx, memos.finishMoves);
  await jobs.init();
  const chat = chatService({ committed: journal.committedFs(), store: deps.chats, model: deps.model, config, now: deps.now, limits: deps.chatLimits });
  return {
    accept: memos.accept,
    routeNext: memos.routeNext,
    confirm: memos.confirm,
    move: memos.move,
    retry: memos.retry,
    runNext: jobs.runNext,
    pass: book.pass,
    async domains() {
      const c = await config();
      return c.ok ? [...c.config.domains.keys()] : null;
    },
    book: {
      current: book.current,
      watch: book.watch,
      memo: (id) => ctx.memoLane(() => book.detail(id)),
      refresh: memos.refresh,
    },
    chats: chat.chats,
    page: chat.page,
    async saveAnswer(turn) {
      const f = await chat.filing(turn);
      return 'id' in f ? jobs.stageAnswer(f) : { kind: 'refused', reason: f };
    },
  };
}
