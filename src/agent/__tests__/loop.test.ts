import assert from 'node:assert/strict';
import type { InputItem } from '../../codex/responses';
import { LIMITS, runAgent, TOOLS, type AgentRequest, type Refused, type Shown, type Workspace } from '../loop';
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
