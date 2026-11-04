import assert from 'node:assert/strict';
import { FolderUnreachable } from '../../core/fs';
import type { DomainName, MemoId } from '../../core/types';
import type { Unavailable } from '../../agent/model';
import type { Engine, JobRef, RouteReport, RunReport } from '../engine';
import { createRunner, type RunnerReport } from '../runner';
import { afterRun, rotation, START, wakeIn, type Schedule } from '../schedule';

const [A, B] = ['스터디', '일상'] as DomainName[] as [DomainName, DomainName];
const job = (d: DomainName): JobRef => ({ kind: 'ingest', domain: d, id: 'X' });
const unavailable = (cause: Unavailable['cause'], retryAfterMs: number): Unavailable => ({ kind: 'unavailable', cause, detail: cause, retryAfterMs });

type Call = { readonly what: 'route' } | { readonly what: 'run'; readonly d: DomainName; readonly withModel: boolean; readonly signal: AbortSignal };

/** An engine that answers from queues, idle when one runs out, and records what it was asked. */
function scripted(routes: RouteReport[], runs: Partial<Record<DomainName, (RunReport | ((c: Call) => Promise<RunReport>))[]>>) {
  const calls: Call[] = [];
  const engine = {
    pass: () => ({ id: 1 }),
    domains: async () => [A, B],
    routeNext: async () => (calls.push({ what: 'route' }), routes.shift() ?? { kind: 'idle' }),
    runNext: async (d: DomainName, o: { withModel: boolean; signal: AbortSignal }) => {
      const c: Call = { what: 'run', d, withModel: o.withModel, signal: o.signal };
      calls.push(c);
      const next = runs[d]?.[0];
      if (!next || (typeof next !== 'function' && next.kind !== 'idle' && !o.withModel && next.kind !== 'committed')) return { kind: 'idle' } as RunReport;
      runs[d]!.shift();
      return typeof next === 'function' ? next(c) : next;
    },
  } as unknown as Engine;
  return { engine, calls };
}

function runnerOn(engine: Engine | null, clock = { now: 0 }) {
  const timers: { ms: number; fire: () => void }[] = [];
  const reports: RunnerReport[] = [];
  const settled: (Schedule['pause'])[] = [];
  const runner: ReturnType<typeof createRunner> = createRunner({
    engine: async () => engine,
    setTimer: (ms, fire) => (timers.push({ ms, fire }), () => {}),
    now: () => clock.now,
    onReport: (r) => reports.push(r),
    onSettled: () => settled.push(runner.schedule().pause),
  });
  return { runner, timers, reports, clock, settled, waits: () => timers.map((t) => t.ms) };
}

test('a pass routes the whole inbox first, then runs one job at a time across domains, routing again between jobs', async () => {
  const e = scripted(
    [{ kind: 'routed', id: '1' as MemoId, domain: A, routing: { by: 'hint' } }, { kind: 'held', id: '2' as MemoId, domain: B, routing: { by: 'fallback', reason: '' } }],
    { [A]: [{ kind: 'committed', job: job(A), verdict: 'created' }, { kind: 'committed', job: job(A), verdict: 'created' }], [B]: [{ kind: 'committed', job: job(B), verdict: 'created' }] },
  );
  const h = runnerOn(e.engine);
  await h.runner.trigger();
  const order = e.calls.map((c) => (c.what === 'route' ? 'route' : c.d));
  assert.deepEqual(order, ['route', 'route', 'route', A, 'route', B, 'route', A, 'route', B, A]);
  assert.deepEqual(h.reports.map((r) => `${r.where === 'domain' ? r.domain : r.where} ${r.kind}`), ['router routed', 'router held', `${A} committed`, `${B} committed`, `${A} committed`]);
  assert.deepEqual(h.waits(), []);
});

test('unavailable pauses every model job for as long as it says, while jobs with no model still run', async () => {
  const e = scripted([{ kind: 'unavailable', unavailable: unavailable('rate-limited', 300_000) }], { [A]: [{ kind: 'committed', job: { kind: 'file-answer', domain: A, id: 'Q' }, verdict: 'saved' }] });
  const h = runnerOn(e.engine);
  await h.runner.trigger();
  const runs = e.calls.filter((c): c is Extract<Call, { what: 'run' }> => c.what === 'run');
  assert.ok(runs.length > 0 && runs.every((c) => !c.withModel), 'no model while paused');
  assert.equal(e.calls.filter((c) => c.what === 'route').length, 1, 'the router waits too');
  assert.deepEqual(h.waits(), [300_000]);
  assert.deepEqual(h.runner.schedule().pause, { until: 300_000, cause: 'rate-limited' });
  h.clock.now = 300_000;
  await h.runner.trigger();
  assert.equal(e.calls.at(-1)!.what, 'run');
  assert.ok(e.calls.slice(-2).some((c) => c.what === 'run' && c.withModel), 'the model runs once the pause is over');
});

test('a login pause ends when the user logs in, a network pause when the network is back, and a model pause when the user picks a model', async () => {
  for (const [cause, end] of [['login', 'loggedIn'], ['network', 'networkBack'], ['model', 'modelPicked']] as const) {
    const e = scripted([], { [A]: [{ kind: 'unavailable', job: job(A), unavailable: unavailable(cause, 600_000) }] });
    const h = runnerOn(e.engine);
    await h.runner.trigger();
    assert.equal(h.runner.schedule().pause?.cause, cause);
    await h.runner[end]();
    assert.equal(h.runner.schedule().pause, null, cause);
  }
  const e = scripted([], { [A]: [{ kind: 'unavailable', job: job(A), unavailable: unavailable('rate-limited', 600_000) }] });
  const h = runnerOn(e.engine);
  await h.runner.trigger();
  await h.runner.networkBack();
  assert.equal(h.runner.schedule().pause?.cause, 'rate-limited', 'a usage limit is not the network');
});

test('a failed attempt backs its domain off for 30 s, then 60 s, while the other domain runs', () => {
  const retrying = (attempt: number): RunReport => ({ kind: 'retrying', job: job(A), attempt, problems: [] });
  const one = afterRun(START, A, retrying(1), 1_000);
  assert.equal(one.backoff.get(A), 31_000);
  assert.equal(wakeIn(one, 1_000), 30_000);
  assert.equal(afterRun(one, A, retrying(2), 31_000).backoff.get(A), 91_000);
  assert.equal(afterRun(one, A, { kind: 'committed', job: job(A), verdict: 'created' }, 31_000).backoff.has(A), false);
  assert.deepEqual(rotation(one, [A, B]), [B, A], 'the next round starts after the domain that ran');
  assert.equal(wakeIn(START, 0), null);
});

test('leaving the foreground aborts the job in flight; the job comes back cancelled and nothing more runs', async () => {
  let started!: () => void;
  const inFlight = new Promise<void>((r) => (started = r));
  const e = scripted([], {
    [A]: [(c) => new Promise<RunReport>((resolve) => {
      started();
      if (c.what === 'run') c.signal.addEventListener('abort', () => resolve({ kind: 'cancelled', job: job(A) }));
    })],
  });
  const h = runnerOn(e.engine);
  const pass = h.runner.trigger();
  await inFlight;
  h.runner.setForeground(false);
  await pass;
  assert.deepEqual(h.reports.map((r) => r.kind), ['cancelled']);
  const calls = e.calls.length;
  await h.runner.trigger();
  assert.equal(e.calls.length, calls, 'no pass in the background');
});

test('an unreachable folder pauses the runner until it is resumed', async () => {
  let reachable = false;
  const engine = {
    pass: () => ({ id: 1 }),
    domains: async () => {
      if (!reachable) throw new FolderUnreachable('content://gone');
      return [A];
    },
    routeNext: async () => ({ kind: 'idle' }),
    runNext: async () => ({ kind: 'idle' }),
  } as unknown as Engine;
  const h = runnerOn(engine);
  await h.runner.trigger();
  assert.deepEqual(h.reports.map((r) => r.kind), ['unreachable']);
  await h.runner.trigger();
  assert.equal(h.reports.length, 1, 'triggers wait while paused');
  reachable = true;
  await h.runner.resume();
  assert.equal(h.reports.length, 1);
});

test('no kept folder, no pass', async () => {
  const h = runnerOn(null);
  await h.runner.trigger();
  assert.deepEqual([h.reports, h.waits()], [[], []]);
});

test('a pause that runs out shows as over after the pass its timer wakes, with no report', async () => {
  const e = scripted([{ kind: 'unavailable', unavailable: unavailable('network', 120_000) }], {});
  const h = runnerOn(e.engine);
  await h.runner.trigger();
  assert.deepEqual(h.settled, [{ until: 120_000, cause: 'network' }]);
  h.clock.now = 120_000;
  h.timers[0]!.fire();
  await h.runner.trigger();
  assert.equal(h.settled.at(-1), null);
  assert.equal(h.reports.length, 1, 'the idle pass reported nothing');
});

test('a login, the network back, or a model pick ends its pause for the app before the pass it starts', async () => {
  for (const [cause, end] of [['login', 'loggedIn'], ['network', 'networkBack'], ['model', 'modelPicked']] as const) {
    const e = scripted([{ kind: 'unavailable', unavailable: unavailable(cause, 600_000) }], {});
    const h = runnerOn(e.engine);
    await h.runner.trigger();
    const routes = e.calls.length;
    h.settled.length = 0;
    const pass = h.runner[end]();
    assert.equal(h.settled[0], null, cause);
    assert.equal(e.calls.length, routes, `${cause}: told before the pass ran`);
    await pass;
  }
});
