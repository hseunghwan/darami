/**
 * The tool loop that replaces `claude -p` and `codex exec`: turns on the Codex endpoint until the
 * model calls `finish`, a limit is hit, or a write is refused.
 *
 * The loop never sees the Fs port, a WikiPath, or the journal. It gets a Workspace, whose
 * implementation (jobs/workspace.ts) holds every rule about what a job may read and write.
 * boundary.test.ts fails if anything in src/agent imports src/fs, core/fs, core/wiki, or src/jobs,
 * so the confinement of Done when 3 is a property of the import graph, not of the prompt.
 */

import type { FunctionCall, FunctionTool, InputItem, OutputItem } from '../codex/responses';
import type { ModelProfile } from '../core/config';
import { INGEST_VERDICTS, type IngestVerdict } from '../core/ledger';
import type { Model, Unavailable } from './model';

/** A tool's answer as the model reads it, an error included. */
export type Shown = { readonly kind: 'shown'; readonly text: string };
/** A write outside the job's write scope. Nothing was written, and the attempt fails with `scope`. `path` is as check() reports it. */
export type Refused = { readonly kind: 'refused'; readonly path: string };

/**
 * The job's folder as its model may use it, paths written relative to the domain folder.
 * - read, list, and search reach only the read scope; elsewhere answers as a missing file does.
 * - write replaces a whole `.md` under wiki/. A file that exists must have been read or written by
 *   this job in its current text, or nothing is written: the plan's reread rule for a second writer.
 * - edit replaces `old`, which must occur exactly once in the file's current text.
 * - index.md and log.md answer an error and the run goes on; _review.md takes only text added at its end.
 * - any other write is Refused.
 */
export type Workspace = {
  read(path: string): Promise<Shown>;
  list(path: string): Promise<Shown>;
  search(query: string): Promise<Shown>;
  write(path: string, text: string): Promise<Shown | Refused>;
  edit(path: string, old: string, next: string): Promise<Shown | Refused>;
};

const str = (description: string) => ({ type: 'string', description });
const tool = (name: string, description: string, properties: Record<string, unknown>): FunctionTool => ({
  type: 'function',
  name,
  description,
  strict: true,
  parameters: { type: 'object', additionalProperties: false, required: Object.keys(properties), properties },
});

export const TOOLS: readonly FunctionTool[] = [
  tool('list', 'List every file under a folder, at any depth. Paths are relative to the domain folder.', {
    path: str('A folder such as `wiki`, `wiki/주제`, or `../일상/wiki`.'),
  }),
  tool('read', 'Read a whole text file.', {
    path: str('A file such as `raw/<id>.md`, `wiki/RAG.md`, or `../일상/wiki/ME.md`.'),
  }),
  tool('search', "Find this domain's wiki pages whose path or text holds every word of the query, ignoring case. Answers each page's path and its first matching lines.", {
    query: str('One or more words.'),
  }),
  tool('write', 'Create a page under `wiki/`, or replace a whole page you have read.', {
    path: str('A `.md` path under `wiki/`, such as `wiki/RAG.md`.'),
    text: str('The whole file: frontmatter, then the body.'),
  }),
  tool('edit', 'Replace one exact passage of a page under `wiki/`.', {
    path: str('A `.md` path under `wiki/`.'),
    old: str('Text that occurs exactly once in the page now.'),
    new: str('What replaces it.'),
  }),
  tool('finish', 'End the work with your verdict. Call it once, last.', {
    verdict: { type: 'string', enum: INGEST_VERDICTS, description: 'created, updated, conflict, or unchanged.' },
  }),
];

export type AgentLimits = {
  /** Model turns per attempt. */
  readonly turns: number;
  /** Wall time per attempt. The runner cancels a job when the app leaves the foreground, so this is foreground time. */
  readonly attemptMs: number;
  /** Turns that end with no tool call before the attempt fails; each gets the nudge. */
  readonly nudges: number;
};

export const LIMITS: AgentLimits = { turns: 40, attemptMs: 8 * 60_000, nudges: 2 };

export type AgentRequest = {
  readonly profile: ModelProfile | null;
  readonly instructions: string;
  readonly prompt: string;
  readonly nudge: string;
  readonly workspace: Workspace;
  readonly limits: AgentLimits;
  readonly signal: AbortSignal;
  readonly now: () => number;
};

/** `finished` carries the model's word only: the applied line's pages come from the journal, as dotoriwiki's came from git status. */
export type AgentResult =
  | { readonly kind: 'finished'; readonly verdict: IngestVerdict }
  | Refused
  | { readonly kind: 'failed'; readonly reason: string }
  | Unavailable
  | { readonly kind: 'cancelled' };

const user = (text: string): InputItem => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const shown = (text: string): Shown => ({ kind: 'shown', text });

export async function runAgent(model: Model, req: AgentRequest): Promise<AgentResult> {
  const input: InputItem[] = [user(req.prompt)];
  const start = req.now();
  let nudges = 0;
  for (let turn = 1; turn <= req.limits.turns; turn++) {
    if (req.now() - start > req.limits.attemptMs) return { kind: 'failed', reason: 'edit run timed out' };
    const r = await model({ role: 'ingest', profile: req.profile, instructions: req.instructions, input: [...input], tools: TOOLS }, req.signal);
    if (!r.ok) return r.problem.kind === 'rejected' ? { kind: 'failed', reason: `the endpoint refused the request: ${r.problem.detail}` } : r.problem;
    input.push(...replay(r.output));
    const calls = r.output.filter((o): o is FunctionCall => o.type === 'function_call');
    if (calls.length === 0) {
      if (++nudges > req.limits.nudges) return { kind: 'failed', reason: 'the model stopped without calling finish' };
      input.push(user(req.nudge));
      continue;
    }
    for (const call of calls) {
      if (call.name === 'finish') {
        const verdict = verdictOf(call.arguments);
        if (verdict) return { kind: 'finished', verdict };
        input.push(answer(call, `error: verdict must be one of ${INGEST_VERDICTS.join(', ')}`));
        continue;
      }
      const out = await dispatch(req.workspace, call);
      if (out.kind === 'refused') return out;
      input.push(answer(call, out.text));
    }
  }
  return { kind: 'failed', reason: `the model did not finish in ${req.limits.turns} turns` };
}

const answer = (call: FunctionCall, output: string): InputItem => ({ type: 'function_call_output', call_id: call.call_id, output });

/**
 * A turn's output as the next turn's input. Requests go with store: false and no
 * previous_response_id, so every turn resends the whole conversation: function calls go back
 * unchanged, a message becomes an assistant message, and reasoning and other items are dropped.
 */
function replay(output: readonly OutputItem[]): readonly InputItem[] {
  return output.flatMap((o): InputItem[] =>
    o.type === 'function_call' ? [o]
    : o.type === 'message' && o.text !== '' ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: o.text }] }]
    : [],
  );
}

const argsOf = (json: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(json);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

function verdictOf(json: string): IngestVerdict | null {
  const v = argsOf(json)?.verdict;
  return INGEST_VERDICTS.find((x) => x === v) ?? null;
}

/** Arguments that are not JSON or lack a field answer an error to the model; they never fail the attempt. */
async function dispatch(ws: Workspace, call: FunctionCall): Promise<Shown | Refused> {
  const args = argsOf(call.arguments);
  if (!args) return shown('error: the arguments are not a JSON object');
  const fields = (...names: string[]): string[] | Shown => {
    const missing = names.filter((n) => typeof args[n] !== 'string');
    return missing.length ? shown(`error: ${call.name} needs ${missing.join(', ')} as text`) : names.map((n) => args[n] as string);
  };
  const run = (names: string[], fn: (...v: string[]) => Promise<Shown | Refused>) => {
    const v = fields(...names);
    return Array.isArray(v) ? fn(...v) : Promise.resolve(v);
  };
  switch (call.name) {
    case 'list': return run(['path'], (p) => ws.list(p!));
    case 'read': return run(['path'], (p) => ws.read(p!));
    case 'search': return run(['query'], (q) => ws.search(q!));
    case 'write': return run(['path', 'text'], (p, t) => ws.write(p!, t!));
    case 'edit': return run(['path', 'old', 'new'], (p, o, n) => ws.edit(p!, o!, n!));
    default: return shown(`error: no tool named ${call.name}`);
  }
}
