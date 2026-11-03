/**
 * Runs the job runner's passes while the app is in the foreground. One pass at a time; a trigger
 * during a pass queues exactly one more.
 */

export type FlushResult =
  | { readonly kind: 'drained' }
  | { readonly kind: 'backoff'; readonly error: string }
  | { readonly kind: 'paused' }
  /** Work waits on time, such as a rate-limit pause: a timer triggers the next pass unless a trigger comes first. */
  | { readonly kind: 'wait'; readonly ms: number };

/** 5 s, 10 s, 20 s … capped at a minute: a phone waking from a dead zone should not wait long. */
export const backoffMs = (failures: number): number => Math.min(5_000 * 2 ** Math.max(0, failures - 1), 60_000);

export type FlusherDeps = {
  /** The signal aborts when the app leaves the foreground. */
  pass: (signal: AbortSignal) => Promise<FlushResult>;
  /** Returns a cancel function. */
  setTimer: (ms: number, fire: () => void) => () => void;
  onResult: (r: FlushResult) => void;
};

export type Flusher = {
  /** Enqueue, foreground and network change all call this. Resolves when the queue is drained or the pass gave up. */
  trigger(): Promise<void>;
  /** After a pass answered paused, such as on a folder that did not answer: run again. */
  resume(): Promise<void>;
  /** Timers only run while the app is in the foreground, and leaving it aborts the pass in flight. */
  setForeground(foreground: boolean): void;
};

/** One flush at a time. A trigger during a pass queues exactly one more pass, so a memo saved mid-flush is never stranded. */
export function createFlusher(deps: FlusherDeps): Flusher {
  let current: Promise<void> | null = null;
  let again = false;
  let paused = false;
  let failures = 0;
  let foreground = true;
  let cancelTimer: (() => void) | null = null;
  let inFlight: AbortController | null = null;

  const clearTimer = () => {
    cancelTimer?.();
    cancelTimer = null;
  };

  const arm = (ms: number) => {
    cancelTimer = deps.setTimer(ms, () => {
      cancelTimer = null;
      void trigger();
    });
  };

  async function loop(): Promise<void> {
    for (;;) {
      again = false;
      const abort = new AbortController();
      inFlight = abort;
      let r: FlushResult;
      try {
        r = await deps.pass(abort.signal);
      } catch (e) {
        r = { kind: 'backoff', error: (e as Error).message };
      }
      inFlight = null;
      if (r.kind === 'paused') paused = true;
      failures = r.kind === 'backoff' ? failures + 1 : 0;
      deps.onResult(r);
      if (!again && foreground) {
        if (r.kind === 'backoff') arm(backoffMs(failures));
        else if (r.kind === 'wait') arm(r.ms);
      }
      // Cleared in the same tick as the check, so a trigger that lands after it starts a new loop.
      if (!again || paused) {
        current = null;
        return;
      }
    }
  }

  function trigger(): Promise<void> {
    if (paused) return Promise.resolve();
    if (current) {
      again = true;
      return current;
    }
    clearTimer();
    current = loop();
    return current;
  }

  return {
    trigger,
    resume() {
      paused = false;
      failures = 0;
      return trigger();
    },
    setForeground(next) {
      foreground = next;
      if (next) void trigger();
      else {
        inFlight?.abort();
        clearTimer();
      }
    },
  };
}
