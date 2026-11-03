/** A scripted Model for the engine and loop tests. Not a test file: testMatch takes *.test.ts only. */

import type { OutputItem } from '../../codex/responses';
import type { Model, ModelRequest, ModelTurn, Unavailable } from '../model';

export type Reply = ModelTurn | Promise<ModelTurn>;

export type Script = {
  /** n counts classify calls from 1. */
  readonly classify?: (req: ModelRequest, n: number) => Reply;
  /** n counts the turns of this attempt from 1: an attempt starts with the prompt alone. */
  readonly ingest?: (req: ModelRequest, n: number) => Reply;
};

export type FakeModel = Model & { readonly requests: ModelRequest[] };

export function fakeModel(script: Script): FakeModel {
  const requests: ModelRequest[] = [];
  let classified = 0;
  let turn = 0;
  const model: Model = async (req) => {
    requests.push(req);
    if (req.role === 'classify') {
      if (!script.classify) throw new Error('the script has no classify turn');
      return script.classify(req, ++classified);
    }
    if (!script.ingest) throw new Error('the script has no ingest turn');
    turn = req.input.length === 1 ? 1 : turn + 1;
    return script.ingest(req, turn);
  };
  return Object.assign(model, { requests });
}

let calls = 0;
const call = (name: string, args: Record<string, unknown>): ModelTurn => ({
  ok: true,
  output: [{ type: 'function_call', call_id: `call_${++calls}`, name, arguments: JSON.stringify(args) }],
  text: '',
});

export const turn = {
  call,
  write: (path: string, text: string) => call('write', { path, text }),
  edit: (path: string, old: string, next: string) => call('edit', { path, old, new: next }),
  read: (path: string) => call('read', { path }),
  list: (path: string) => call('list', { path }),
  search: (query: string) => call('search', { query }),
  finish: (verdict: string) => call('finish', { verdict }),
  /** A turn with no tool call. */
  say: (text: string, extra: readonly OutputItem[] = []): ModelTurn => ({ ok: true, output: [{ type: 'message', text }, ...extra], text }),
  /** The classifier's strict-schema answer. */
  route: (domain: string, confidence: number, reason: string): ModelTurn => {
    const text = JSON.stringify({ domain, confidence, reason });
    return { ok: true, output: [{ type: 'message', text }], text };
  },
  unavailable: (cause: Unavailable['cause'], retryAfterMs = 300_000): ModelTurn => ({ ok: false, problem: { kind: 'unavailable', cause, detail: cause, retryAfterMs } }),
  rejected: (detail: string): ModelTurn => ({ ok: false, problem: { kind: 'rejected', detail } }),
  cancelled: (): ModelTurn => ({ ok: false, problem: { kind: 'cancelled' } }),
};

/** Plays the turns in order, one per turn of an attempt; running out fails the test. */
export const plays = (...turns: readonly Reply[]) => (_req: ModelRequest, n: number): Reply => {
  const t = turns[n - 1];
  if (!t) throw new Error(`the script has no turn ${n}`);
  return t;
};
