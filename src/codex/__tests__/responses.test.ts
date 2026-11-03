import type { Fetch } from '../auth';
import { createEventParser, createTurnCollector, failureFromStatus, headers, requestBody, runTurn, type TurnRequest } from '../responses';
import { textSse, toolCallSse } from './fixtures/streams';

const noHeaders = { headers: { get: () => null } };
const replay = (sse: string, chunk = 97) => {
  const parser = createEventParser();
  const deltas: string[] = [];
  const c = createTurnCollector((d) => deltas.push(d));
  for (let i = 0; i < sse.length; i += chunk) parser.push(sse.slice(i, i + chunk)).forEach(c.accept);
  parser.end().forEach(c.accept);
  return { result: c.result(), deltas };
};

const req: TurnRequest = { model: 'gpt-6-luna', instructions: 'Be brief.', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] };

describe('the request', () => {
  it('always streams, never stores, and runs one tool at a time', () => {
    expect(requestBody(req)).toMatchObject({ model: 'gpt-6-luna', instructions: 'Be brief.', stream: true, store: false, parallel_tool_calls: false, tools: [], reasoning: null });
  });

  it('asks for a strict JSON schema when given one', () => {
    const body = requestBody({ ...req, effort: 'low', schema: { name: 'c', schema: { type: 'object' } } });
    expect(body.text).toEqual({ format: { type: 'json_schema', name: 'c', schema: { type: 'object' }, strict: true } });
    expect(body.reasoning).toEqual({ effort: 'low' });
  });

  it('names the account and the app', () => {
    expect(headers({ accessToken: 'at', accountId: 'acct' })).toMatchObject({ authorization: 'Bearer at', 'chatgpt-account-id': 'acct', originator: 'darami' });
  });
});

describe('the stream', () => {
  it('collects a text answer and its deltas from a recorded stream, however it is chunked', () => {
    for (const chunk of [1, 13, 97, 100_000]) {
      const { result, deltas } = replay(textSse, chunk);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.text.length).toBeGreaterThan(0);
      expect(deltas.join('')).toBe(result.text);
      expect(result.usage?.inputTokens).toBeGreaterThan(0);
    }
  });

  it('collects a function call from a recorded stream', () => {
    const { result } = replay(toolCallSse);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const calls = result.output.filter((o) => o.type === 'function_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: 'read_file', arguments: '{"path":"notes.md"}' });
  });

  it('fails a stream that ends before response.completed', () => {
    const sse = textSse;
    const { result } = replay(sse.slice(0, sse.indexOf('event: response.completed')));
    expect(result).toEqual({ ok: false, failure: { kind: 'network', detail: 'the stream ended before response.completed' } });
  });

  it('reports response.failed, and a usage limit as a rate limit', () => {
    const c = createTurnCollector();
    c.accept({ event: 'response.failed', data: { type: 'response.failed', response: { error: { code: 'usage_limit_reached', message: 'limit' } } } });
    expect(c.result()).toEqual({ ok: false, failure: { kind: 'rate-limited', retryAfterMs: 300_000, detail: 'limit' } });
  });
});

describe('HTTP failures', () => {
  it('reads the 401 the endpoint gave for a bad token', () => {
    const text = JSON.stringify({ detail: 'Could not parse your authentication token. Please try signing in again.' });
    expect(failureFromStatus(401, text, noHeaders)).toEqual({ kind: 'unauthorized', detail: 'Could not parse your authentication token. Please try signing in again.' });
  });

  it('reads the 400 the endpoint gave for a model the plan does not offer', () => {
    const text = JSON.stringify({ detail: "The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account." });
    expect(failureFromStatus(400, text, noHeaders)).toMatchObject({ kind: 'rejected', status: 400 });
  });

  it('waits as long as a 429 says, and at least a minute', () => {
    const get = (v: string | null) => ({ headers: { get: (n: string) => (n === 'retry-after' ? v : null) } });
    expect(failureFromStatus(429, '', get('600'))).toMatchObject({ kind: 'rate-limited', retryAfterMs: 600_000 });
    expect(failureFromStatus(429, '', get('5'))).toMatchObject({ retryAfterMs: 60_000 });
    expect(failureFromStatus(429, '{"error":{"resets_in_seconds": 1200}}', noHeaders)).toMatchObject({ retryAfterMs: 1_200_000 });
    expect(failureFromStatus(429, '', noHeaders)).toMatchObject({ retryAfterMs: 300_000 });
  });
});

describe('runTurn', () => {
  it('reads a body that cannot stream as one block of text', async () => {
    const fetchFn = (async () => ({ status: 200, body: null, text: async () => textSse, headers: { get: () => null } })) as unknown as Fetch;
    const r = await runTurn(fetchFn, { accessToken: 'a', accountId: 'b' }, req);
    expect(r.ok).toBe(true);
  });

  it('turns a thrown fetch into a network failure', async () => {
    const fetchFn = (async () => {
      throw new Error('offline');
    }) as unknown as Fetch;
    expect(await runTurn(fetchFn, { accessToken: 'a', accountId: 'b' }, req)).toEqual({ ok: false, failure: { kind: 'network', detail: 'offline' } });
  });
});
