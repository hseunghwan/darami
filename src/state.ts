import * as Crypto from 'expo-crypto';
import * as Network from 'expo-network';
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import type { MachineFacts } from './core/config';
import { parseMemo } from './core/pages';
import { inspectFolder, setUpWiki, type FolderState } from './core/wiki';
import { phoneModel } from './agent/codex';
import { MODEL_PROFILES } from './agent/model';
import { pickSafTree, safFs } from './fs/saf';
import { parseSafTree, type SafTree } from './fs/saf-uri';
import { buildMemoRequest, type CaptureInput } from './lib/capture';
import { kv, outbox } from './lib/db';
import { adopt, sweepPending } from './lib/files';
import { createFlusher } from './lib/flusher';
import { gateway, observeGateway } from './lib/gateway';
import type { Candidate, Usable } from './lib/folder';
import { flushOnce } from './lib/outbox';
import { parseStoredPairing, type Pairing } from './lib/pairing';
import { attachmentsOf, type DraftPhoto } from './lib/photos';
import type { StatusResponse } from './lib/wire';
import { openEngine, type AcceptResult, type Engine, type EngineEvent } from './jobs/engine';
import { createRunner, type Pause, type RunnerReport } from './jobs/runner';
import { sqliteBook, sqliteJournal } from './jobs/sqlite';
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
  pairing: Pairing | null;
  /** Domain folder names from the last GET /status, cached so the chips work offline. */
  domains: string[];
  /** null until the first call answers or fails. */
  reachable: boolean | null;
  /** A 401 paused the outbox; the user has to pair again. */
  authLost: boolean;
  settings: Settings;
  /** The wiki folder the user kept. Its domains are its own; `domains` above stays the gateway's until P4. */
  folder: Folder | null;
  jobs: JobsView;
};

let app: App = {
  ready: false, pairing: null, domains: [], reachable: null, authLost: false, settings: { location: false, theme: 'system' }, folder: null,
  jobs: { paused: null, last: null },
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

const flusher = createFlusher({
  pass: async () => {
    const p = app.pairing;
    if (!p || app.authLost) return { kind: 'paused' };
    return flushOnce(
      outbox.store,
      (row) => gateway.postMemo(p, row.body),
      (_row, file) => gateway.putAttachment(p, file),
    );
  },
  setTimer: (ms, fire) => {
    const t = setTimeout(fire, ms);
    return () => clearTimeout(t);
  },
  onResult: () => {},
});

export const flushNow = (): Promise<void> => flusher.trigger();

/** Saves the memo to the outbox first; the returned promise is only the send attempt. */
export async function capture(input: Omit<CaptureInput, 'id' | 'at' | 'attachments'> & { photos?: readonly DraftPhoto[] }): Promise<{ id: string; sent: Promise<void> }> {
  const id = Crypto.randomUUID();
  const at = new Date();
  const { photos = [], ...rest } = input;
  const files: { n: number; path: string }[] = [];
  for (const [i, photo] of photos.entries()) files.push({ n: i + 1, path: await adopt(photo.uri, id, i + 1) });
  const body = buildMemoRequest({ ...rest, id, at, attachments: attachmentsOf(photos) });
  await outbox.enqueue(id, JSON.stringify(body), at.toISOString(), files);
  return { id, sent: flusher.trigger() };
}

export async function pair(pairing: Pairing, status: StatusResponse): Promise<void> {
  await SecureStore.setItemAsync('pairing', JSON.stringify(pairing));
  await rememberDomains(status);
  set({ pairing, authLost: false, reachable: true });
  void flusher.resume();
}

async function rememberDomains(status: StatusResponse): Promise<void> {
  const domains = Object.keys(status.domains);
  set({ domains });
  await kv.set('domains', JSON.stringify(domains));
}

export async function refreshStatus(): Promise<StatusResponse | null> {
  const p = app.pairing;
  if (!p) return null;
  const r = await gateway.status(p);
  if (!r.ok) return null;
  await rememberDomains(r.data);
  return r.data;
}

export async function updateSettings(patch: Partial<Settings>): Promise<void> {
  const settings = { ...app.settings, ...patch };
  set({ settings });
  await kv.set('settings', JSON.stringify(settings));
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

/** Every runner report and engine event, the recent ones first: the dev screen's log, and P4's activity until it reads the ledgers. */
export function observeJobs(listener: (n: JobNote) => void): () => void {
  notes.forEach(listener);
  noteListeners.add(listener);
  return () => noteListeners.delete(listener);
}

/** One engine per kept wiki folder: two on one folder would each take the other's live job for stale. */
let opened: { readonly uri: string; readonly engine: Promise<Engine> } | null = null;

function engineFor(folder: Folder | null): Promise<Engine> | null {
  if (folder?.state?.kind !== 'wiki') return null;
  if (opened?.uri !== folder.tree.uri) {
    const engine = openEngine({
      fs: safFs(folder.tree),
      journal: sqliteJournal(folder.tree.uri),
      book: sqliteBook(folder.tree.uri),
      model: phoneModel,
      machine: MACHINE,
      now: () => new Date(),
      onEvent: note,
    });
    const mine = { uri: folder.tree.uri, engine };
    opened = mine;
    // A folder that did not answer is opened again on the next pass.
    engine.catch(() => {
      if (opened === mine) opened = null;
    });
  }
  return opened.engine;
}

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
  },
  onSettled: () => {
    const { pause } = runner.schedule();
    if (pause !== app.jobs.paused) set({ jobs: { ...app.jobs, paused: pause } });
  },
});

/** Runs a pass now: what a sent memo, the foreground, a kept folder, and the dev screen do. */
export const runJobs = (): Promise<void> => runner.trigger();
/** After a login: model work paused on the old one goes on. */
export const jobsLoggedIn = (): Promise<void> => runner.loggedIn();

/** Files a typed memo through the engine and wakes the runner: the dev screen's path now, compose's in P4. */
export async function fileMemo(input: { readonly text: string; readonly domainHint: string | null }): Promise<{ readonly id: string; readonly result: AcceptResult | { readonly kind: 'no-wiki' } | { readonly kind: 'invalid'; readonly detail: string } }> {
  const id = Crypto.randomUUID();
  const parsed = parseMemo(buildMemoRequest({ id, text: input.text, at: new Date(), source: 'typed', domainHint: input.domainHint, location: null, attachments: [] }));
  if (!parsed.ok) return { id, result: { kind: 'invalid', detail: parsed.detail } };
  const engine = engineFor(app.folder);
  if (!engine) return { id, result: { kind: 'no-wiki' } };
  const result = await (await engine).accept(parsed.value);
  void runner.trigger();
  return { id, result };
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

/**
 * Inspects the kept folder again and shows what it found, unless another folder was kept meanwhile.
 * An I/O error keeps what was shown; the next recheck tries again.
 */
export async function recheckFolder(): Promise<void> {
  const kept = app.folder;
  if (!kept) return;
  const state = await inspect(kept.tree).catch(() => kept.state);
  if (app.folder?.tree.uri !== kept.tree.uri) return;
  set({ folder: { tree: kept.tree, state } });
  if (state?.kind === 'wiki') void runner.resume();
}

function parseFolder(text: string | null): Folder | null {
  const t = text ? parseSafTree(text) : null;
  return t?.ok ? { tree: t.value, state: null } : null;
}

function parseDomains(text: string | null): string[] {
  try {
    const v: unknown = text ? JSON.parse(text) : [];
    return Array.isArray(v) ? v.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
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
    observeGateway({
      unauthorized: () => set({ authLost: true }),
      reachability: (reachable) => {
        if (reachable !== app.reachable) set({ reachable });
      },
    });
    const [pairing, domains, settings, folder] = await Promise.all([
      SecureStore.getItemAsync('pairing').then(parseStoredPairing),
      kv.get('domains').then(parseDomains),
      kv.get('settings').then(parseSettings),
      kv.get('folder').then(parseFolder),
    ]);
    set({ ready: true, pairing, domains, settings, folder });
    void recheckFolder();
    sweepPending();

    AppState.addEventListener('change', (s) => {
      flusher.setForeground(s === 'active');
      runner.setForeground(s === 'active');
    });
    Network.addNetworkStateListener((e) => {
      if (!e.isConnected) return;
      void flusher.trigger();
      void runner.networkBack();
    });
    void flusher.trigger();
    if (pairing) void refreshStatus();
  })();
  return booted;
}
