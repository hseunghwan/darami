import assert from 'node:assert/strict';
import type { Credentials, ModelFailure, TurnRequest, TurnResult } from '../../codex/responses';
import type { ModelProfile } from '../../core/config';
import type { DomainName } from '../../core/types';
import {
  choiceFor, classify, codexModel, MODEL_PROFILES, MODELS, NO_CHOICE, parseModelChoice, problemOf, TURN_STALL_MS, type CredentialsAnswer, type ModelChoice, type ModelRequest,
} from '../model';
import { fakeModel, turn } from './fake-model';

const creds = (n: number): Credentials => ({ accessToken: `t${n}`, accountId: 'acct' });
const ok: TurnResult = { ok: true, output: [{ type: 'message', text: 'hi' }], text: 'hi', usage: null };
const fail = (failure: ModelFailure): TurnResult => ({ ok: false, failure });
const req: ModelRequest = { role: 'ingest', profile: null, instructions: 'i', input: [] };

/** codexModel over scripted credentials and turns, recording what each turn was sent. */
function harness(answers: { creds?: CredentialsAnswer[]; turns: ((r: TurnRequest) => TurnResult | Promise<TurnResult>)[]; choice?: () => ModelChoice }) {
  const sent: { creds: Credentials; req: TurnRequest }[] = [];
  const asked: { force?: boolean }[] = [];
  const timers: { ms: number; fire: () => void; cancelled: boolean }[] = [];
  let n = 0;
  const model = codexModel({
    credentials: async (opts) => (asked.push(opts), answers.creds?.shift() ?? { ok: true, creds: creds(++n) }),
    runTurn: async (c, r) => (sent.push({ creds: c, req: r }), answers.turns.shift()!(r)),
    setTimer: (ms, fire) => {
      const t = { ms, fire, cancelled: false };
      timers.push(t);
      return () => void (t.cancelled = true);
    },
    choice: answers.choice ?? (() => NO_CHOICE),
  });
  return { model, sent, asked, timers };
}

test('with no pick, luna runs at low effort to classify and chat and at medium to ingest, and the only profile is default', () => {
  assert.deepEqual(choiceFor('classify', null, NO_CHOICE), { model: 'gpt-6-luna', effort: 'low' });
  assert.deepEqual(choiceFor('ingest', null, NO_CHOICE), { model: 'gpt-6-luna', effort: 'medium' });
  assert.deepEqual(choiceFor('ingest', 'strong' as ModelProfile, NO_CHOICE), MODELS.ingest.default);
  assert.deepEqual([...MODEL_PROFILES], ['default']);
  assert.deepEqual(choiceFor('chat', 'strong' as ModelProfile, NO_CHOICE), { model: 'gpt-6-luna', effort: 'low' }, 'chat ignores model_profile');
});

test('the filing pick runs classify and ingest, model_profile included, and the Ask pick runs chat', () => {
  const sol = { model: 'gpt-6-sol', effort: 'high' } as const;
  const astra = { model: 'gpt-6-astra', effort: 'minimal' } as const;
  const choice: ModelChoice = { filing: sol, ask: astra };
  assert.deepEqual(choiceFor('classify', null, choice), sol);
  assert.deepEqual(choiceFor('ingest', 'default' as ModelProfile, choice), sol);
  assert.deepEqual(choiceFor('chat', null, choice), astra);
  assert.deepEqual(choiceFor('chat', null, { filing: sol, ask: null }), MODELS.chat, 'an Ask left on default stays on it');
  assert.deepEqual(choiceFor('classify', null, { filing: null, ask: astra }), MODELS.classify);
});

test('the pick survives kv as JSON, and anything unreadable there is the default', () => {
  const choice: ModelChoice = { filing: { model: 'gpt-6-sol', effort: 'high' }, ask: null };
  assert.deepEqual(parseModelChoice(JSON.stringify(choice)), choice);
  assert.deepEqual(parseModelChoice(null), NO_CHOICE);
  assert.deepEqual(parseModelChoice('{not json'), NO_CHOICE);
  assert.deepEqual(parseModelChoice('"gpt-6-sol"'), NO_CHOICE);
  assert.deepEqual(parseModelChoice(JSON.stringify({ filing: { model: 'gpt-6-sol', effort: 'xhigh' }, ask: { model: '', effort: 'low' } })), NO_CHOICE, 'an unknown effort or an empty model is dropped');
});

test('each turn sends the model and effort picked for its role, read at that turn', async () => {
  let choice: ModelChoice = { filing: { model: 'gpt-6-sol', effort: 'high' }, ask: { model: 'gpt-6-astra', effort: 'medium' } };
  const h = harness({ turns: [() => ok, () => ok, () => ok, () => ok], choice: () => choice });
  const signal = new AbortController().signal;
  await h.model({ ...req, role: 'classify' }, signal);
  await h.model({ ...req, role: 'ingest' }, signal);
  await h.model({ ...req, role: 'chat' }, signal);
  choice = NO_CHOICE;
  await h.model({ ...req, role: 'ingest' }, signal);
  assert.deepEqual(h.sent.map((s) => [s.req.model, s.req.effort]), [['gpt-6-sol', 'high'], ['gpt-6-sol', 'high'], ['gpt-6-astra', 'medium'], ['gpt-6-luna', 'medium']]);
});

test("a chat turn's text deltas reach the caller as the stream sends them", async () => {
  const seen: string[] = [];
  const h = harness({ turns: [(r) => (r.onText?.('a'), r.onText?.('b'), ok)] });
  await h.model({ ...req, role: 'chat', onText: (d) => seen.push(d) }, new AbortController().signal);
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(h.sent[0]!.req.effort, 'low');
});

test('a turn goes out with the role\'s model and effort, and the request as given', async () => {
  const h = harness({ turns: [() => ok] });
  assert.deepEqual(await h.model({ ...req, role: 'classify', schema: { name: 's', schema: {} } }, new AbortController().signal), { ok: true, output: ok.output, text: 'hi' });
  assert.equal(h.sent[0]!.req.model, 'gpt-6-luna');
  assert.equal(h.sent[0]!.req.effort, 'low');
  assert.deepEqual(h.sent[0]!.req.schema, { name: 's', schema: {} });
});

test('a 401 gets one forced refresh and one more try; a second 401 is a login pause', async () => {
  const unauthorized = () => fail({ kind: 'unauthorized', detail: 'bad token' });
  const once = harness({ turns: [unauthorized, () => ok] });
  assert.equal((await once.model(req, new AbortController().signal)).ok, true);
  assert.deepEqual(once.asked, [{}, { force: true }]);
  assert.deepEqual(once.sent.map((s) => s.creds.accessToken), ['t1', 't2']);
  const twice = harness({ turns: [unauthorized, unauthorized] });
  assert.deepEqual(await twice.model(req, new AbortController().signal), { ok: false, problem: { kind: 'unavailable', cause: 'login', detail: 'bad token', retryAfterMs: 600_000 } });
});

test('no login, or a refresh token that is spent, is a login pause without a turn', async () => {
  for (const failure of [{ kind: 'logged-out' }, { kind: 'login-again', code: 'refresh_token_expired' }]) {
    const h = harness({ creds: [{ ok: false, failure }], turns: [] });
    const r = await h.model(req, new AbortController().signal);
    assert.ok(!r.ok && r.problem.kind === 'unavailable' && r.problem.cause === 'login', failure.kind);
    assert.equal(h.sent.length, 0);
  }
  const offline = harness({ creds: [{ ok: false, failure: { kind: 'network', detail: 'offline' } }], turns: [] });
  const r = await offline.model(req, new AbortController().signal);
  assert.ok(!r.ok && r.problem.kind === 'unavailable' && r.problem.cause === 'network');
});

test('failures map to dotoriwiki\'s waits: the endpoint\'s for a usage limit, 10 min for a model, 2 min for the server or network', () => {
  assert.deepEqual(problemOf({ kind: 'rate-limited', retryAfterMs: 123_000, detail: 'usage limit' }, false), { kind: 'unavailable', cause: 'rate-limited', detail: 'usage limit', retryAfterMs: 123_000 });
  assert.deepEqual(problemOf({ kind: 'rejected', status: 400, detail: "The 'gpt-9' model is not supported when using Codex with a ChatGPT account." }, false), {
    kind: 'unavailable', cause: 'model', detail: "The 'gpt-9' model is not supported when using Codex with a ChatGPT account.", retryAfterMs: 600_000,
  });
  assert.deepEqual(problemOf({ kind: 'rejected', status: 400, detail: 'input too long' }, false), { kind: 'rejected', detail: '400 input too long' });
  assert.deepEqual(problemOf({ kind: 'server', status: 503, detail: 'overloaded' }, false), { kind: 'unavailable', cause: 'server', detail: 'overloaded', retryAfterMs: 120_000 });
  assert.deepEqual(problemOf({ kind: 'network', detail: 'offline' }, false), { kind: 'unavailable', cause: 'network', detail: 'offline', retryAfterMs: 120_000 });
  assert.equal(problemOf({ kind: 'cancelled' }, true).kind, 'unavailable', 'a stall is the server, not a cancel');
});

const untilAborted = (r: TurnRequest) => new Promise<TurnResult>((resolve) => r.signal!.addEventListener('abort', () => resolve(fail({ kind: 'cancelled' }))));

test('a stream that sends nothing for two minutes is a server pause, and each piece that arrives restarts the wait', async () => {
  const h = harness({ turns: [untilAborted] });
  const pending = h.model(req, new AbortController().signal);
  await new Promise((r) => setTimeout(r, 0));
  h.sent[0]!.req.onChunk!();
  assert.deepEqual(h.timers.map((t) => [t.ms, t.cancelled]), [[TURN_STALL_MS, true], [TURN_STALL_MS, false]]);
  h.timers[1]!.fire();
  const r = await pending;
  assert.ok(!r.ok && r.problem.kind === 'unavailable' && r.problem.cause === 'server');
});

test('the caller\'s abort is a cancel', async () => {
  const h = harness({ turns: [untilAborted] });
  const abort = new AbortController();
  const pending = h.model(req, abort.signal);
  await new Promise((r) => setTimeout(r, 0));
  abort.abort();
  assert.deepEqual(await pending, { ok: false, problem: { kind: 'cancelled' } });
});

test('a classify try answers a declared domain; a refused request is a failed try, and unavailable passes through', async () => {
  const domains = ['일상', '스터디'] as DomainName[];
  const ask = (m: ReturnType<typeof fakeModel>) => classify(m, { instructions: 'i', text: '메모', domains }, new AbortController().signal);
  const m = fakeModel({ classify: () => turn.route('스터디', 0.9, '공부') });
  assert.deepEqual(await ask(m), { kind: 'classified', domain: '스터디', confidence: 0.9, reason: '공부' });
  assert.deepEqual((m.requests[0]!.schema!.schema as { properties: { domain: { enum: string[] } } }).properties.domain.enum, domains);
  assert.deepEqual(await ask(fakeModel({ classify: () => turn.rejected('400 bad schema') })), { kind: 'no-answer', detail: '400 bad schema' });
  assert.equal((await ask(fakeModel({ classify: () => turn.unavailable('rate-limited') }))).kind, 'unavailable');
});
