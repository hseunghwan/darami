/**
 * Runs the engine while the app is in the foreground, on lib/flusher.ts: one job at a time for the
 * whole app. dotoriwiki ran a worker per domain; a phone has one network and the account one rate
 * limit, so parallel domains would only meet the same 429 sooner, and a background cancel has one
 * job to roll back.
 *
 * A pass routes the inbox first, so a memo just sent shows its domain in seconds, then runs one job
 * in the next domain of the rotation, then routes again, until nothing can run now. Then the
 * flusher waits until the earliest pause or backoff ends, or the next trigger.
 *
 * Nothing here outlives a kill: the memo is in inbox/ or raw/ and the journal row in SQLite, and
 * the first pass after a launch recovers it.
 */

import { FolderUnreachable } from '../core/fs';
import type { DomainName } from '../core/types';
import { createFlusher, type FlushResult } from '../lib/flusher';
import type { Engine, RouteReport, RunReport } from './engine';
import { afterLogin, afterModelPick, afterNetwork, afterRoute, afterRun, expire, modelAllowed, rotation, START, wakeIn, type Schedule } from './schedule';

/** Model work waits until `until`. */
export type Pause = NonNullable<Schedule['pause']>;

export type RunnerReport =
  | ({ readonly where: 'router' } & Exclude<RouteReport, { readonly kind: 'idle' }>)
  | ({ readonly where: 'domain'; readonly domain: DomainName } & Exclude<RunReport, { readonly kind: 'idle' }>)
  | { readonly where: 'runner'; readonly kind: 'unreachable' | 'error'; readonly message: string };

export type Runner = {
  /** A memo sent, the app in the foreground, a folder kept. */
  trigger(): Promise<void>;
  /** Ends a login pause and runs. */
  loggedIn(): Promise<void>;
  /** Ends a network or server pause and runs. */
  networkBack(): Promise<void>;
  /** Ends a pause for a refused model and runs. */
  modelPicked(): Promise<void>;
  /** After an unreachable folder answers again. */
  resume(): Promise<void>;
  /** Leaving the foreground cancels the running job, which rolls back with no line and no attempt spent. */
  setForeground(foreground: boolean): void;
  /** Never a pause that is over. */
  schedule(): Schedule;
};

export type RunnerDeps = {
  /** null while no wiki folder is kept. */
  readonly engine: () => Promise<Engine | null>;
  readonly setTimer: (ms: number, fire: () => void) => () => void;
  readonly now: () => number;
  readonly onReport: (r: RunnerReport) => void;
  /** After every pass, and when a login or the network ends a pause: an idle pass reports nothing, so this is when a pause shown as on can turn off. */
  readonly onSettled: () => void;
};

const DRAINED: FlushResult = { kind: 'drained' };

export function createRunner(deps: RunnerDeps): Runner {
  let s: Schedule = START;
  let foreground = true;

  async function pass(signal: AbortSignal): Promise<FlushResult> {
    s = expire(s, deps.now());
    if (!foreground) return DRAINED;
    try {
      const engine = await deps.engine();
      if (!engine) return DRAINED;
      const one = engine.pass();
      for (;;) {
        const domains = await engine.domains();
        if (!domains || signal.aborted) return DRAINED;
        if (modelAllowed(s, null, deps.now())) {
          const r = await engine.routeNext(signal, one);
          s = afterRoute(s, r, deps.now());
          if (r.kind !== 'idle') deps.onReport({ where: 'router', ...r });
          if (r.kind === 'cancelled' || r.kind === 'paused') return DRAINED;
          if (r.kind !== 'idle' && r.kind !== 'unavailable') continue;
        }
        let ran = false;
        for (const d of rotation(s, domains)) {
          const r = await engine.runNext(d, { withModel: modelAllowed(s, d, deps.now()), signal, pass: one });
          s = afterRun(s, d, r, deps.now());
          if (r.kind === 'idle') continue;
          deps.onReport({ where: 'domain', domain: d, ...r });
          if (r.kind === 'cancelled' || r.kind === 'paused') return DRAINED;
          ran = true;
          break;
        }
        if (!ran) {
          const ms = wakeIn(s, deps.now());
          return ms === null ? DRAINED : { kind: 'wait', ms };
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof FolderUnreachable) {
        deps.onReport({ where: 'runner', kind: 'unreachable', message });
        return { kind: 'paused' };
      }
      deps.onReport({ where: 'runner', kind: 'error', message });
      throw e;
    }
  }

  const flusher = createFlusher({ pass, setTimer: deps.setTimer, onResult: () => deps.onSettled() });

  return {
    trigger: () => flusher.trigger(),
    loggedIn() {
      s = afterLogin(s);
      deps.onSettled();
      return flusher.trigger();
    },
    networkBack() {
      s = afterNetwork(s);
      deps.onSettled();
      return flusher.trigger();
    },
    modelPicked() {
      s = afterModelPick(s);
      deps.onSettled();
      return flusher.trigger();
    },
    resume: () => flusher.resume(),
    setForeground(next) {
      foreground = next;
      flusher.setForeground(next);
    },
    schedule: () => (s = expire(s, deps.now())),
  };
}
