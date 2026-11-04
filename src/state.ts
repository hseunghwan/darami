import { File } from 'expo-file-system';
import * as Network from 'expo-network';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import type { ChatId } from './core/chat';
import type { MachineFacts } from './core/config';
import { FolderUnreachable } from './core/fs';
import { parseMemo, type PageRef } from './core/pages';
import type { ChatTarget, DomainName, MemoId } from './core/types';
import { inspectFolder, setUpWiki, type FolderState } from './core/wiki';
import { parseWikiPath, paths } from './core/layout';
import { phoneModel } from './agent/codex';
import { phonePhotoTools } from './media/phone';
import { articleFetcher } from './links/fetch';
import { MODEL_PROFILES, NO_CHOICE, parseModelChoice, type ModelChoice, type RoleModel } from './agent/model';
import { completeDeviceLogin, requestDeviceCode, type AuthFailure, type DeviceCode } from './codex/auth';
import { loadSession, logOut as forgetLogin, saveTokens } from './codex/session';
import { pickSafTree, safFs } from './fs/saf';
import { documentUri, parseSafTree, type SafTree } from './fs/saf-uri';
import { buildMemoRequest, type GeoFix } from './lib/capture';
import { chatLogLine, type Asked, type Saved } from './lib/chats';
import { kv } from './lib/db';
import { fileName, removeQuietly, sweepPending } from './lib/files';
import { DRAFT_KEY, parseSavedDraft } from './lib/draft';
import type { DraftPhoto } from './lib/photos';
import { isUsable, type Candidate, type Usable } from './lib/folder';
import { loginOf, type Login } from './lib/login';
import type { Released } from './lib/memos';
import {
  openEngine, type ChatProgress, type ChatSummary, type ChatView, type Engine, type EngineEvent, type MemoBook, type MemoDetail, type PageView, type PhotoRefusal, type Question, type ReleaseResult, type TurnRef,
} from './jobs/engine';
import { createRunner, type Pause, type RunnerReport } from './jobs/runner';
import { sqliteBook, sqliteChats, sqliteJournal } from './jobs/sqlite';
import { locale } from './text';

export type ThemePref = 'system' | 'dark' | 'light';
export type Settings = { location: boolean; theme: ThemePref };

export type Folder = {
  readonly tree: SafTree;
  /** null while it is being inspected. Never stored: derived from the folder each time. */
  readonly state: FolderState | null;
};

/** What the screens show about jobs. A running job is in the memo book. */
export type JobsView = {
  /** runner.schedule().pause after the last pass: null once it ran out or a login or the network ended it. */
  readonly paused: Pause | null;
  readonly last: RunnerReport | null;
};

export type App = {
  ready: boolean;
  settings: Settings;
  /** The wiki folder the user kept. */
  folder: Folder | null;
  jobs: JobsView;
  login: Login;
  /** The kept folder's memos once its engine opened; null with no usable folder or before it opens. */
  book: MemoBook | null;
  /** Whether the phone has a network, as expo-network last said; null until it answers. */
  online: boolean | null;
  /** The models picked in Settings, kept in kv `models`. */
  models: ModelChoice;
};

let app: App = {
  ready: false, settings: { location: false, theme: 'system' }, folder: null, jobs: { paused: null, last: null }, login: { kind: 'out' }, book: null, online: null, models: NO_CHOICE,
};
const listeners = new Set<() => void>();

function set(patch: Partial<App>): void {
  app = { ...app, ...patch };
  listeners.forEach((l) => l());
}

export function useApp<T>(select: (a: App) => T): T {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => select(app),
  );
}

export const getApp = (): App => app;

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const settings = { ...app.settings, ...patch };
  set({ settings });
  await kv.set('settings', JSON.stringify(settings));
}

/** null puts the role back on the default. The next turn uses it, and a pause for a refused model ends. */
export async function pickModel(role: keyof ModelChoice, pick: RoleModel | null): Promise<void> {
  const models = { ...app.models, [role]: pick };
  set({ models });
  await kv.set('models', JSON.stringify(models));
  void runner.modelPicked();
}

/** model_profile names a key of agent/model.ts MODELS.ingest, so a profile added there stops warning with no second list. */
const MACHINE: MachineFacts = { modelProfiles: MODEL_PROFILES };

export type JobNote = RunnerReport | EngineEvent;
const NOTES_KEPT = 200;
const notes: JobNote[] = [];
const noteListeners = new Set<(n: JobNote) => void>();

function note(n: JobNote): void {
  notes.push(n);
  if (notes.length > NOTES_KEPT) notes.shift();
  noteListeners.forEach((l) => l(n));
}

/** Every runner report and engine event, the recent ones first: the dev screen's log. */
export function observeJobs(listener: (n: JobNote) => void): () => void {
  notes.forEach(listener);
  noteListeners.add(listener);
  return () => noteListeners.delete(listener);
}

const phoneFetchSource = articleFetcher({
  http: fetch,
  online: () => Network.getNetworkStateAsync().then((n) => n.isConnected !== false && n.isInternetReachable !== false, () => true),
  setTimer: (ms, fire) => {
    const t = setTimeout(fire, ms);
    return () => clearTimeout(t);
  },
});

/** One engine per kept wiki folder: two on one folder would each take the other's live job for stale. */
let opened: { readonly uri: string; readonly engine: Promise<Engine>; unwatch: () => void } | null = null;

/** Opened for a broken wiki too: memos still go into inbox/ and wait until dotoriwiki.yaml is fixed. */
function engineFor(folder: Folder | null): Promise<Engine> | null {
  if (!folder?.state || !isUsable(folder.state)) return null;
  if (opened?.uri !== folder.tree.uri) {
    opened?.unwatch();
    if (app.book) set({ book: null });
    const engine = openEngine({
      fs: safFs(folder.tree),
      journal: sqliteJournal(folder.tree.uri),
      book: sqliteBook(folder.tree.uri),
      chats: sqliteChats(folder.tree.uri),
      model: phoneModel(() => app.models),
      machine: MACHINE,
      now: () => new Date(),
      onEvent: note,
      photos: phonePhotoTools,
      fetchSource: phoneFetchSource,
    });
    const mine = { uri: folder.tree.uri, engine, unwatch: () => {} };
    opened = mine;
    engine.then(
      (e) => {
        if (opened !== mine) return;
        const show = () => set({ book: e.book.current() });
        mine.unwatch = e.book.watch(show);
        show();
      },
      // A folder that did not answer is opened again on the next pass.
      () => {
        if (opened === mine) opened = null;
      },
    );
  }
  return opened.engine;
}

/** The kept folder's engine, once the inspection in flight answers: a share sent at a cold start waits for it instead of finding no folder. */
async function usableEngine(): Promise<Engine | null> {
  if (app.folder && app.folder.state === null) await recheckFolder();
  return engineFor(app.folder);
}

/** The kept wiki's declared domains in config order: the hint chips and the move sheet. Empty while it is not a wiki. */
export function useDomains(): readonly DomainName[] {
  const domains = useApp((a) => (a.folder?.state?.kind === 'wiki' ? a.folder.state.config.domains : null));
  return useMemo(() => (domains ? [...domains.keys()] : []), [domains]);
}

/** A 401 that a forced refresh did not cure, this launch: the login reads expired even while its tokens are stored. */
let refused = false;

async function readLogin(): Promise<void> {
  set({ login: loginOf(await loadSession(), refused) });
}

export type LoginEnd = { readonly ok: true } | { readonly ok: false; readonly failure: AuthFailure };
export type LoginStart =
  | { readonly ok: true; readonly code: DeviceCode; readonly done: Promise<LoginEnd>; readonly cancel: () => void }
  | { readonly ok: false; readonly failure: AuthFailure };

/** A device code to show, then the login finishing in the background once the user approves it. */
export async function startLogin(): Promise<LoginStart> {
  const c = await requestDeviceCode(fetch);
  if (!c.ok) return c;
  // The emulator run reads the code from logcat.
  if (__DEV__) console.log(`LOGIN code ${c.value.userCode}`);
  const abort = new AbortController();
  const done = (async (): Promise<LoginEnd> => {
    const r = await completeDeviceLogin(fetch, c.value, { signal: abort.signal });
    if (!r.ok) return r;
    await saveTokens(r.value);
    refused = false;
    set({ login: { kind: 'in', email: r.value.email, plan: r.value.plan } });
    void runner.loggedIn();
    return { ok: true };
  })();
  return { ok: true, code: c.value, done, cancel: () => abort.abort() };
}

/** The gate then opens the login step. */
export async function logOut(): Promise<void> {
  await forgetLogin();
  refused = false;
  set({ login: { kind: 'out' } });
}

/** Settings' File now: ends a network or server pause and runs a pass. A usage limit keeps its wait. */
export const fileNow = (): Promise<void> => runner.networkBack();

const isLoginPause = (r: RunnerReport) => (r.where === 'router' || r.where === 'domain') && r.kind === 'unavailable' && r.unavailable.cause === 'login';

const runner = createRunner({
  engine: async () => engineFor(app.folder),
  setTimer: (ms, fire) => {
    const t = setTimeout(fire, ms);
    return () => clearTimeout(t);
  },
  now: Date.now,
  onReport: (r) => {
    set({ jobs: { ...app.jobs, last: r } });
    note(r);
    if (isLoginPause(r)) {
      refused = true;
      void readLogin();
    }
    if (r.where === 'runner' && r.kind === 'unreachable') void recheckFolder();
  },
  onSettled: () => {
    const { pause } = runner.schedule();
    if (pause !== app.jobs.paused) set({ jobs: { ...app.jobs, paused: pause } });
  },
});

/** Runs a pass now: what a sent memo, the foreground, a kept folder, and the dev screen do. */
export const runJobs = (): Promise<void> => runner.trigger();

/** A memo as compose holds it. `id` lives as long as the draft, so sending again after a failure is the same memo. */
export type Capture = {
  readonly id: string;
  readonly text: string;
  readonly source: 'typed' | 'share' | 'selection' | 'chat';
  readonly domainHint: string | null;
  readonly location: GeoFix | null;
  /** Photo n is photos[n - 1], each a file the app holds until the memo is filed. */
  readonly photos?: readonly DraftPhoto[];
};

export type Filed =
  /** inbox/<id>.md is whole: written now, or by an earlier send of the same draft. */
  | { readonly kind: 'filed' }
  /** No folder kept, or it reads unreachable, foreign, or empty. */
  | { readonly kind: 'no-wiki' }
  | { readonly kind: 'invalid'; readonly detail: string }
  /** The folder threw part way; sending again with the same id finishes it. */
  | { readonly kind: 'failed'; readonly message: string }
  /** Nothing was written: photo n is gone, unreadable on this phone, or other bytes than an earlier send of this draft. */
  | PhotoRefusal;

/** A pending photo's bytes, or null once the file is gone. */
async function readPending(uri: string): Promise<Uint8Array | null> {
  const f = new File(uri);
  return f.exists ? f.bytes() : null;
}

/**
 * Resolves only after accept answers, so the caller clears its draft on `filed` and on nothing
 * else. The photos' files are deleted once the memo is filed, since the folder then holds every
 * byte; on any other answer they stay for the next send.
 */
export async function fileMemo(c: Capture): Promise<Filed> {
  const photos = c.photos ?? [];
  const parsed = parseMemo(buildMemoRequest({ id: c.id, text: c.text, at: new Date(), source: c.source, domainHint: c.domainHint, location: c.location, photos }));
  if (!parsed.ok) return { kind: 'invalid', detail: parsed.detail };
  try {
    const engine = await usableEngine();
    if (!engine) return { kind: 'no-wiki' };
    const r = await engine.accept(parsed.value, (n) => readPending(photos[n - 1]!.uri));
    if (r.kind === 'photo-refused') return r;
    removeQuietly(photos.map((p) => p.uri));
    void runner.trigger();
    return { kind: 'filed' };
  } catch (e) {
    if (e instanceof FolderUnreachable) void recheckFolder();
    return { kind: 'failed', message: e instanceof Error ? e.message : String(e) };
  }
}

/** `to`: the domain a move asked for, which a wiki without it answers as not found. */
function releasedOf(r: ReleaseResult, to?: DomainName): Released {
  switch (r.kind) {
    case 'released':
      return r;
    case 'not-found':
      return to !== undefined && app.folder?.state?.kind === 'wiki' && !app.folder.state.config.domains.has(to) ? { kind: 'no-domain' } : { kind: 'gone' };
    case 'conflict':
      return { kind: 'moved-on', started: r.at.state === 'routed' || r.at.state === 'running' || r.at.state === 'ingested' };
    case 'paused':
      return r;
  }
}

/** The book shows what these change on its own, through the engine's writes. */
async function release(act: (e: Engine) => Promise<ReleaseResult>, to?: DomainName): Promise<Released> {
  try {
    const engine = await usableEngine();
    if (!engine) return { kind: 'gone' };
    const r = await act(engine);
    void runner.trigger();
    return releasedOf(r, to);
  } catch (e) {
    return { kind: 'failed', message: e instanceof Error ? e.message : String(e) };
  }
}

export const confirmMemo = (id: MemoId): Promise<Released> => release((e) => e.confirm(id));
export const moveMemo = (id: MemoId, to: DomainName): Promise<Released> => release((e) => e.move(id, to), to);

export async function retryMemo(id: MemoId, domain: DomainName): Promise<'retrying' | 'not-failed'> {
  const engine = await usableEngine().catch(() => null);
  const r = engine ? await engine.retry(domain, id).catch(() => 'not-failed' as const) : 'not-failed';
  void runner.trigger();
  return r;
}

/** Pull to refresh: the folder checked again, every memo folder read again, then a pass. */
export async function refreshMemos(): Promise<void> {
  await recheckFolder();
  const engine = await usableEngine().catch(() => null);
  await engine?.book.refresh().catch(() => {});
  void runner.trigger();
}

export type MemoDetailState = { readonly kind: 'loading' } | { readonly kind: 'missing' } | { readonly kind: 'shown'; readonly memo: MemoDetail };

/** The memo's detail, read again each time its row in the book changes. */
export function useMemoDetail(id: string): MemoDetailState {
  const row = useApp((a) => a.book?.byId.get(id as MemoId));
  const ready = useApp((a) => a.book?.ready ?? false);
  const [state, setState] = useState<MemoDetailState>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    void (async () => {
      const engine = await usableEngine().catch(() => null);
      const memo = engine ? await engine.book.memo(id as MemoId).catch(() => null) : null;
      if (!live) return;
      if (memo) setState({ kind: 'shown', memo });
      else if (ready || !engine) setState({ kind: 'missing' });
    })();
    return () => void (live = false);
  }, [id, row, ready]);
  return state;
}

/**
 * One question. A chat that finds the login spent marks it refused, as a runner login pause does,
 * so the gate and Settings show "log in again". A chat failure never touches the runner's schedule.
 */
export async function askWiki(q: Question, onProgress: (p: ChatProgress) => void, signal: AbortSignal): Promise<Asked> {
  const start = Date.now();
  let firstTextMs: number | null = null;
  const progress = (p: ChatProgress) => {
    if (firstTextMs === null && p.kind === 'text') firstTextMs = Date.now() - start;
    onProgress(p);
  };
  let r: Asked;
  try {
    const engine = await usableEngine();
    r = engine ? await engine.chats.ask(q, progress, signal) : { kind: 'no-wiki' };
  } catch (e) {
    if (e instanceof FolderUnreachable) void recheckFolder();
    r = e instanceof FolderUnreachable ? { kind: 'unreachable' } : { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
  if (r.kind === 'failed' && r.turn.failure === 'login') {
    refused = true;
    void readLogin();
  }
  // The emulator run reads each question's outcome from logcat.
  if (__DEV__) console.log(chatLogLine(r, { target: q.target, ms: Date.now() - start, firstTextMs }));
  return r;
}

/** The file-answer job needs no model, so a staged answer is filed even during a usage-limit pause. */
export async function saveAnswer(turn: TurnRef): Promise<Saved> {
  try {
    const engine = await usableEngine();
    if (!engine) return { kind: 'no-wiki' };
    const r = await engine.saveAnswer(turn);
    if (r.kind === 'staged') void runner.trigger();
    return r;
  } catch (e) {
    if (e instanceof FolderUnreachable) void recheckFolder();
    return { kind: 'failed', message: e instanceof Error ? e.message : String(e) };
  }
}

/** The question as a memo, with the chat's domain as the hint. Its id is fixed per turn, so a second tap changes nothing. */
export const rememberQuestion = (turn: { readonly memo: MemoId; readonly question: string }, target: ChatTarget): Promise<Filed> =>
  fileMemo({ id: turn.memo, text: turn.question, source: 'chat', domainHint: target.kind === 'domain' ? target.domain : null, location: null });

/** null when there is no wiki or it did not answer. */
export async function pastChats(): Promise<readonly ChatSummary[] | null> {
  const engine = await usableEngine().catch(() => null);
  return engine ? engine.chats.list().catch(() => null) : null;
}

export async function openChat(id: ChatId): Promise<ChatView | null> {
  const engine = await usableEngine().catch(() => null);
  return engine ? engine.chats.open(id).catch(() => null) : null;
}

export async function deleteChat(id: ChatId): Promise<boolean> {
  const engine = await usableEngine().catch(() => null);
  return engine ? engine.chats.remove(id).then(() => true, () => false) : false;
}

export type PageState = { readonly kind: 'loading' } | { readonly kind: 'missing' } | { readonly kind: 'shown'; readonly page: PageView };

/** The document URI of a copy in the kept folder's _attachments/, for Image, or null for a name that is not a plain file name there. */
export function attachmentUri(file: string): string | null {
  const tree = app.folder?.tree;
  const path = file.includes('/') ? null : parseWikiPath(`${paths.attachments}/${file}`);
  return tree && path ? documentUri(tree, path) : null;
}

/** A wiki page for the viewer, read again whenever the memo book changes, so a commit that rewrites it shows. */
export function usePage(ref: PageRef): PageState {
  const book = useApp((a) => a.book);
  const [state, setState] = useState<PageState>({ kind: 'loading' });
  useEffect(() => {
    let live = true;
    void (async () => {
      const engine = await usableEngine().catch(() => null);
      const page = engine ? await engine.page(ref).catch(() => null) : null;
      if (live) setState(page ? { kind: 'shown', page } : { kind: 'missing' });
    })();
    return () => void (live = false);
  }, [ref.domain, ref.page, book]);
  return state;
}

const inspect = (tree: SafTree) => inspectFolder(safFs(tree), MACHINE, locale);

/** The picker, opened at the kept folder or Documents, and what it returned. null when cancelled. Keeps nothing. */
export async function pickFolder(): Promise<Candidate | null> {
  const p = await pickSafTree(app.folder?.tree ?? null);
  if (p.kind === 'cancelled') return null;
  if (p.kind === 'unsupported') return p;
  return { kind: 'checked', tree: p.tree, state: await inspect(p.tree) };
}

/** Writes or finishes the preset (setUpWiki refuses any other folder) and answers the new state. Keeps nothing. */
export function setUpFolder(tree: SafTree): Promise<FolderState> {
  return setUpWiki(safFs(tree), { locale, zone: Intl.DateTimeFormat().resolvedOptions().timeZone || undefined, machine: MACHINE });
}

export const checkFolder = inspect;

/** Keeps the folder: kv holds only its URI. */
export async function keepFolder(tree: SafTree, state: Usable): Promise<void> {
  await kv.set('folder', tree.uri);
  set({ folder: { tree, state } });
  void runner.resume();
}

let inspecting: { readonly uri: string; readonly done: Promise<void> } | null = null;

/**
 * Inspects the kept folder again and shows what it found, unless another folder was kept meanwhile.
 * A call while one is in flight shares it. An I/O error keeps what was shown; the next recheck tries again.
 */
export function recheckFolder(): Promise<void> {
  const kept = app.folder;
  if (!kept) return Promise.resolve();
  if (inspecting?.uri === kept.tree.uri) return inspecting.done;
  const done = (async () => {
    const state = await inspect(kept.tree).catch(() => kept.state);
    if (app.folder?.tree.uri !== kept.tree.uri) return;
    set({ folder: { tree: kept.tree, state } });
    if (state && isUsable(state)) void runner.resume();
  })().finally(() => {
    if (inspecting?.done === done) inspecting = null;
  });
  inspecting = { uri: kept.tree.uri, done };
  return done;
}

function parseFolder(text: string | null): Folder | null {
  const t = text ? parseSafTree(text) : null;
  return t?.ok ? { tree: t.value, state: null } : null;
}

function parseSettings(text: string | null): Settings {
  try {
    const v = text ? (JSON.parse(text) as Partial<Settings>) : {};
    return {
      location: typeof v.location === 'boolean' ? v.location : app.settings.location,
      theme: v.theme === 'dark' || v.theme === 'light' ? v.theme : 'system',
    };
  } catch {
    return app.settings;
  }
}

let booted: Promise<void> | null = null;

export function boot(): Promise<void> {
  booted ??= (async () => {
    const [settings, folder, session, models] = await Promise.all([
      kv.get('settings').then(parseSettings),
      kv.get('folder').then(parseFolder),
      loadSession().catch(() => ({ kind: 'none' }) as const),
      kv.get('models').then(parseModelChoice, () => NO_CHOICE),
    ]);
    set({ ready: true, settings, folder, login: loginOf(session, false), models });
    void recheckFolder();
    const draft = parseSavedDraft(await kv.get(DRAFT_KEY).catch(() => null));
    sweepPending(new Set(draft?.photos.map((p) => fileName(p.uri)) ?? []));

    AppState.addEventListener('change', (s) => runner.setForeground(s === 'active'));
    void Network.getNetworkStateAsync().then((n) => set({ online: n.isConnected ?? null }), () => {});
    Network.addNetworkStateListener((e) => {
      if ((e.isConnected ?? null) !== app.online) set({ online: e.isConnected ?? null });
      if (e.isConnected) void runner.networkBack();
    });
  })();
  return booted;
}
