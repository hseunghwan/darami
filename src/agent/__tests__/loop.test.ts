import assert from 'node:assert/strict';
import type { InputItem } from '../../codex/responses';
import { CHAT_LIMITS, CHAT_TOOLS, LIMITS, runAgent, runChat, TOOLS, type AgentRequest, type ChatProgress, type ChatRequest, type Reader, type Refused, type Shown, type Workspace } from '../loop';
import { fakeModel, plays, turn } from './fake-model';

/** A workspace that answers each call with its name and arguments, and refuses one path. */
function echoWorkspace(): Workspace & { calls: string[] } {
  const calls: string[] = [];
  const shown = (text: string): Shown => ({ kind: 'shown', text });
  return {
    calls,
    read: async (p) => (calls.push(`read ${p}`), shown(`text of ${p}`)),
    list: async (p) => (calls.push(`list ${p}`), shown(`files of ${p}`)),
    search: async (q) => (calls.push(`search ${q}`), shown(`hits of ${q}`)),
    write: async (p, t): Promise<Shown | Refused> => (calls.push(`write ${p}`), p.startsWith('../') ? { kind: 'refused', path: p.slice(3) } : shown(`wrote ${p} (${t.length})`)),
    edit: async (p, o, n) => (calls.push(`edit ${p} ${o}→${n}`), shown(`edited ${p}`)),
  };
}

const request = (ws: Workspace, over: Partial<AgentRequest> = {}): AgentRequest => ({
  profile: null, instructions: 'rules', prompt: 'file raw/A.md', nudge: 'call finish', workspace: ws, limits: LIMITS,
  signal: new AbortController().signal, now: () => 0, ...over,
});

const outputs = (input: readonly InputItem[]) => input.filter((i) => i.type === 'function_call_output').map((i) => (i as { output: string }).output);

test('each tool call goes to the workspace and its answer comes back in the next turn, until finish', async () => {
  const ws = echoWorkspace();
  const model = fakeModel({ ingest: plays(turn.read('raw/A.md'), turn.list('wiki'), turn.search('RAG 청크'), turn.write('wiki/RAG.md', 'x'), turn.edit('wiki/RAG.md', 'x', 'y'), turn.finish('created')) });
  assert.deepEqual(await runAgent(model, request(ws)), { kind: 'finished', verdict: 'created' });
  assert.deepEqual(ws.calls, ['read raw/A.md', 'list wiki', 'search RAG 청크', 'write wiki/RAG.md', 'edit wiki/RAG.md x→y']);
  assert.deepEqual(outputs(model.requests.at(-1)!.input), ['text of raw/A.md', 'files of wiki', 'hits of RAG 청크', 'wrote wiki/RAG.md (1)', 'edited wiki/RAG.md']);
  assert.deepEqual(model.requests[0]!.tools, TOOLS);
  assert.equal(model.requests[0]!.instructions, 'rules');
});

test('a turn goes back as input: the call unchanged, a message as assistant text, reasoning dropped', async () => {
  const reasoning = { type: 'other' as const, raw: { type: 'reasoning', summary: [] } };
  const read = turn.read('raw/A.md');
  assert.ok(read.ok);
  const both = { ok: true as const, output: [{ type: 'message' as const, text: '먼저 읽는다' }, reasoning, ...read.output], text: '먼저 읽는다' };
  const model = fakeModel({ ingest: plays(both, turn.finish('unchanged')) });
  await runAgent(model, request(echoWorkspace()));
  assert.deepEqual(model.requests[1]!.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'file raw/A.md' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '먼저 읽는다' }] },
    read.output[0],
    { type: 'function_call_output', call_id: (read.output[0] as { call_id: string }).call_id, output: 'text of raw/A.md' },
  ]);
});

test('a refused write ends the attempt at once, with no more turns spent', async () => {
  const ws = echoWorkspace();
  const model = fakeModel({ ingest: plays(turn.write('wiki/ok.md', 'x'), turn.write('../일상/wiki/x.md', 'x'), turn.finish('created')) });
  assert.deepEqual(await runAgent(model, request(ws)), { kind: 'refused', path: '일상/wiki/x.md' });
  assert.equal(model.requests.length, 2);
});

test('a turn with no tool call gets the nudge, and the third such turn fails the attempt', async () => {
  const model = fakeModel({ ingest: plays(turn.say('다 했다'), turn.say('정말'), turn.say('끝')) });
  assert.deepEqual(await runAgent(model, request(echoWorkspace())), { kind: 'failed', reason: 'the model stopped without calling finish' });
  assert.equal(model.requests.length, 3);
  assert.deepEqual(model.requests[1]!.input.at(-1), { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'call finish' }] });
  const recovers = fakeModel({ ingest: plays(turn.say('다 했다'), turn.finish('unchanged')) });
  assert.deepEqual(await runAgent(recovers, request(echoWorkspace())), { kind: 'finished', verdict: 'unchanged' });
});

test('bad arguments, an unknown tool, and a bad verdict are answered, and the attempt goes on', async () => {
  const model = fakeModel({
    ingest: plays(
      { ok: true, output: [{ type: 'function_call', call_id: 'c1', name: 'read', arguments: '{"path":' }], text: '' },
      turn.call('read', { file: 'x' }),
      turn.call('delete', { path: 'wiki/x.md' }),
      turn.finish('saved'),
      turn.finish('conflict'),
    ),
  });
  assert.deepEqual(await runAgent(model, request(echoWorkspace())), { kind: 'finished', verdict: 'conflict' });
  assert.deepEqual(outputs(model.requests.at(-1)!.input), [
    'error: the arguments are not a JSON object',
    'error: read needs path as text',
    'error: no tool named delete',
    'error: verdict must be one of created, updated, conflict, unchanged',
  ]);
});

test('the turn limit and the attempt deadline fail the attempt with rule llm reasons', async () => {
  const forever = fakeModel({ ingest: () => turn.read('raw/A.md') });
  assert.deepEqual(await runAgent(forever, request(echoWorkspace(), { limits: { ...LIMITS, turns: 5 } })), { kind: 'failed', reason: 'the model did not finish in 5 turns' });
  assert.equal(forever.requests.length, 5);
  let clock = 0;
  const slow = fakeModel({ ingest: () => ((clock += 3 * 60_000), turn.read('raw/A.md')) });
  assert.deepEqual(await runAgent(slow, request(echoWorkspace(), { now: () => clock })), { kind: 'failed', reason: 'edit run timed out' });
  assert.equal(slow.requests.length, 3, 'turns until 8 minutes have passed');
});

test('unavailable and cancelled come back as they are, and a refused request fails the attempt', async () => {
  assert.equal((await runAgent(fakeModel({ ingest: plays(turn.read('raw/A.md'), turn.unavailable('rate-limited')) }), request(echoWorkspace()))).kind, 'unavailable');
  assert.deepEqual(await runAgent(fakeModel({ ingest: plays(turn.cancelled()) }), request(echoWorkspace())), { kind: 'cancelled' });
  assert.deepEqual(await runAgent(fakeModel({ ingest: plays(turn.rejected('400 input too long')) }), request(echoWorkspace())), { kind: 'failed', reason: 'the endpoint refused the request: 400 input too long' });
});

test('every tool schema is strict: all properties required, none extra', () => {
  assert.deepEqual(TOOLS.map((t) => t.name), ['list', 'read', 'search', 'write', 'edit', 'finish']);
  for (const t of TOOLS) {
    const p = t.parameters as { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean };
    assert.equal(t.strict, true, t.name);
    assert.equal(p.additionalProperties, false, t.name);
    assert.deepEqual(p.required, Object.keys(p.properties), t.name);
  }
});

/** A reader that answers each look with its name and argument. */
function echoReader(): Reader & { calls: string[] } {
  const calls: string[] = [];
  const shown = (text: string): Shown => ({ kind: 'shown', text });
  return {
    calls,
    read: async (p) => (calls.push(`read ${p}`), shown(`text of ${p}`)),
    list: async (p) => (calls.push(`list ${p}`), shown(`files of ${p}`)),
    search: async (q) => (calls.push(`search ${q}`), shown(`hits of ${q}`)),
  };
}

function ask(reader: Reader, over: Partial<ChatRequest> = {}): ChatRequest & { progress: ChatProgress[] } {
  const progress: ChatProgress[] = [];
  return {
    instructions: 'chat rules', history: [], question: 'RAG?', wrapUp: 'answer now', reader, limits: CHAT_LIMITS,
    signal: new AbortController().signal, now: () => 0, onProgress: (p) => progress.push(p), progress, ...over,
  };
}

const user = (text: string) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const assistant = (text: string) => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

test('a chat streams each turn, drops a preamble once its turn calls a tool, and answers with the final message', async () => {
  const reader = echoReader();
  const index = turn.read('스터디/wiki/index.md');
  const model = fakeModel({
    chat: plays(turn.stream(['Let me ', 'look.'], index), (req) => {
      req.onText?.('RAG is ');
      req.onText?.('[[스터디/wiki/RAG]]');
      return { ok: true, output: [{ type: 'message', text: 'RAG is [[스터디/wiki/RAG]].' }], text: 'RAG is [[스터디/wiki/RAG]].' };
    }),
  });
  const req = ask(reader);
  const r = await runChat(model, req);
  assert.deepEqual(r, { kind: 'answered', text: 'RAG is [[스터디/wiki/RAG]].', wrapped: false, trace: { turns: 2, tools: ['read'] } });
  assert.deepEqual(req.progress, [
    { kind: 'text', text: 'Let me ' },
    { kind: 'text', text: 'Let me look.' },
    { kind: 'reading', paths: ['스터디/wiki/index.md'] },
    { kind: 'text', text: 'RAG is ' },
    { kind: 'text', text: 'RAG is [[스터디/wiki/RAG]]' },
  ]);
  assert.deepEqual(reader.calls, ['read 스터디/wiki/index.md']);
  assert.ok(index.ok);
  assert.deepEqual(model.requests[1]!.input, [
    user('RAG?'),
    assistant('Let me look.'),
    index.output[0],
    { type: 'function_call_output', call_id: (index.output[0] as { call_id: string }).call_id, output: 'text of 스터디/wiki/index.md' },
  ]);
  for (const q of model.requests) {
    assert.equal(q.role, 'chat');
    assert.deepEqual(q.tools, CHAT_TOOLS);
    assert.equal(q.instructions, 'chat rules');
  }
});

test('earlier turns go out as question and answer text, before the question', async () => {
  const model = fakeModel({ chat: plays(turn.say('three')) });
  await runChat(model, ask(echoReader(), { history: [{ question: 'one?', answer: 'one' }, { question: 'two?', answer: 'two' }], question: 'three?' }));
  assert.deepEqual(model.requests[0]!.input, [user('one?'), assistant('one'), user('two?'), assistant('two'), user('three?')]);
});

test('a chat has no tool that writes: write, edit, finish, and unknown names answer errors and reach nothing', async () => {
  const reader = echoReader();
  const model = fakeModel({
    chat: plays(turn.write('스터디/wiki/x.md', 'x'), turn.edit('스터디/wiki/x.md', 'a', 'b'), turn.finish('created'), turn.call('rm', { path: 'x' }), turn.say('done')),
  });
  assert.equal((await runChat(model, ask(reader))).kind, 'answered');
  assert.deepEqual(reader.calls, []);
  assert.deepEqual(outputs(model.requests.at(-1)!.input), ['error: no tool named write', 'error: no tool named edit', 'error: no tool named finish', 'error: no tool named rm']);
});

test('past the turn or time limit, one more turn goes out with no tools, and its answer is kept as wrapped', async () => {
  const forever = fakeModel({ chat: (_req, n) => (n <= 3 ? turn.read(`p${n}.md`) : turn.say('what I have')) });
  const r = await runChat(forever, ask(echoReader(), { limits: { ...CHAT_LIMITS, turns: 3 } }));
  assert.deepEqual(r, { kind: 'answered', text: 'what I have', wrapped: true, trace: { turns: 4, tools: ['read', 'read', 'read'] } });
  const last = forever.requests.at(-1)!;
  assert.deepEqual(last.tools, []);
  assert.deepEqual(last.input.at(-1), { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'answer now' }] });
  assert.deepEqual(forever.requests.slice(0, 3).map((q) => q.tools), [CHAT_TOOLS, CHAT_TOOLS, CHAT_TOOLS]);

  const stubborn = fakeModel({ chat: () => turn.read('again.md') });
  const s = await runChat(stubborn, ask(echoReader(), { limits: { ...CHAT_LIMITS, turns: 2 } }));
  assert.equal(s.kind === 'failed' && s.reason, 'turns');
  assert.equal(stubborn.requests.length, 3);

  let clock = 0;
  const slow = fakeModel({ chat: () => ((clock += 2 * 60_000), clock > 4 * 60_000 ? turn.say('late') : turn.search('x')) });
  const t = await runChat(slow, ask(echoReader(), { now: () => clock }));
  assert.equal(t.kind === 'answered' && t.wrapped, true);
  assert.equal(slow.requests.length, 3, 'two turns until 3 minutes have passed, then the last one');
});

test('a blank answer and a refused request fail; unavailable and cancelled come back as they are', async () => {
  assert.equal(((await runChat(fakeModel({ chat: plays(turn.say('  ')) }), ask(echoReader()))) as { reason: string }).reason, 'empty');
  assert.deepEqual(await runChat(fakeModel({ chat: plays(turn.rejected('400 too long')) }), ask(echoReader())), { kind: 'failed', reason: 'rejected', detail: '400 too long', trace: { turns: 1, tools: [] } });
  assert.equal((await runChat(fakeModel({ chat: plays(turn.search('x'), turn.unavailable('rate-limited')) }), ask(echoReader()))).kind, 'unavailable');
  assert.deepEqual(await runChat(fakeModel({ chat: plays(turn.cancelled()) }), ask(echoReader())), { kind: 'cancelled' });
});

test('a chat offers list, read, and search only, each strict', () => {
  assert.deepEqual(CHAT_TOOLS.map((t) => t.name), ['list', 'read', 'search']);
  for (const t of CHAT_TOOLS) {
    const p = t.parameters as { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean };
    assert.equal(t.strict, true, t.name);
    assert.deepEqual(p.required, Object.keys(p.properties), t.name);
  }
});
