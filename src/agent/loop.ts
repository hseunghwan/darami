/**
 * The tool loops that replace `claude -p` and `codex exec`: ingest's runAgent, turns on the Codex
 * endpoint until the model calls `finish`, a limit is hit, or a write is refused; and chat's
 * runChat, turns until one ends with no tool call, whose message is the answer. They are two loops
 * because they differ in every rule a mode flag would branch on (tools, the stop rule, streaming),
 * and they share replay and the read tools' dispatch, which stay private to this file.
 *
 * The loop never sees the Fs port, a WikiPath, or the journal. It gets a Workspace, whose
 * implementation (jobs/workspace.ts) holds every rule about what a job may read and write.
 * boundary.test.ts fails if anything in src/agent imports src/fs, core/fs, core/wiki, or src/jobs,
 * so the confinement of Done when 3 is a property of the import graph, not of the prompt.
 */

import type { FunctionCall, FunctionTool, InputItem, OutputItem } from '../codex/responses';
import type { ModelProfile } from '../core/config';
import { INGEST_VERDICTS, type IngestVerdict } from '../core/ledger';
import type { JpegDataUrl } from '../core/photos';
import type { Model, Unavailable } from './model';

/** A tool's answer as the model reads it, an error included. */
export type Shown = { readonly kind: 'shown'; readonly text: string };
/** A write outside the job's write scope. Nothing was written, and the attempt fails with `scope`. `path` is as check() reports it. */
export type Refused = { readonly kind: 'refused'; readonly path: string };

/** The tools that only look. A chat gets a Reader, so nothing it holds can change a file. */
export type Reader = {
  read(path: string): Promise<Shown>;
  list(path: string): Promise<Shown>;
  search(query: string): Promise<Shown>;
};

/**
 * The job's folder as its model may use it, paths written relative to the domain folder.
 * - read, list, and search reach only the read scope; elsewhere answers as a missing file does.
 * - write replaces a whole `.md` under wiki/. A file that exists must have been read or written by
 *   this job in its current text, or nothing is written: the plan's reread rule for a second writer.
 * - edit replaces `old`, which must occur exactly once in the file's current text.
 * - index.md and log.md answer an error and the run goes on; _review.md takes only text added at its end.
 * - any other write is Refused.
 */
export type Workspace = Reader & {
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
  /** The memo's photos in prompt order, after the prompt on the first user message. Every turn resends that message, so each is paid for every turn. */
  readonly images: readonly JpegDataUrl[];
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

const user = (text: string, images: readonly JpegDataUrl[] = []): InputItem => ({
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text }, ...images.map((image_url) => ({ type: 'input_image' as const, image_url }))],
});
const shown = (text: string): Shown => ({ kind: 'shown', text });

export async function runAgent(model: Model, req: AgentRequest): Promise<AgentResult> {
  const input: InputItem[] = [user(req.prompt, req.images)];
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
function withArgs<T>(call: FunctionCall, names: readonly string[], fn: (...v: string[]) => Promise<T>): Promise<T | Shown> {
  const args = argsOf(call.arguments);
  if (!args) return Promise.resolve(shown('error: the arguments are not a JSON object'));
  const missing = names.filter((n) => typeof args[n] !== 'string');
  return missing.length ? Promise.resolve(shown(`error: ${call.name} needs ${missing.join(', ')} as text`)) : fn(...names.map((n) => args[n] as string));
}

/** list, read, and search, which both loops offer; null for any other name. */
function dispatchRead(r: Reader, call: FunctionCall): Promise<Shown> | null {
  switch (call.name) {
    case 'list': return withArgs(call, ['path'], (p) => r.list(p!));
    case 'read': return withArgs(call, ['path'], (p) => r.read(p!));
    case 'search': return withArgs(call, ['query'], (q) => r.search(q!));
    default: return null;
  }
}

function dispatch(ws: Workspace, call: FunctionCall): Promise<Shown | Refused> {
  const looked = dispatchRead(ws, call);
  if (looked) return looked;
  switch (call.name) {
    case 'write': return withArgs(call, ['path', 'text'], (p, t) => ws.write(p!, t!));
    case 'edit': return withArgs(call, ['path', 'old', 'new'], (p, o, n) => ws.edit(p!, o!, n!));
    default: return Promise.resolve(shown(`error: no tool named ${call.name}`));
  }
}

/** A chat's tools, paths from the wiki folder. loop.test pins the names, so a tool that writes fails a test. */
export const CHAT_TOOLS: readonly FunctionTool[] = [
  tool('list', 'List every file under a folder of the wiki, at any depth. Paths start at the wiki folder.', {
    path: str('A folder such as `스터디/wiki` or `_schema`.'),
  }),
  tool('read', 'Read a whole text file.', {
    path: str('A file such as `스터디/wiki/index.md`, `스터디/wiki/RAG.md`, or `CLAUDE.md`.'),
  }),
  tool('search', "Find wiki pages whose path, summary, or text holds every word of the query, ignoring case. Looks at the pages each wiki/index.md lists, best matches first. Answers each page's path and its first matching lines.", {
    query: str('One or more words.'),
  }),
];

export type ChatLimits = {
  /** Model turns with tools per question. After them, one more turn goes out with no tools. */
  readonly turns: number;
  /** Wall time per question before that last turn. */
  readonly askMs: number;
};

export const CHAT_LIMITS: ChatLimits = { turns: 10, askMs: 3 * 60_000 };

/**
 * What the screen shows while a question runs. Each event replaces the last, so the screen only
 * sets state. `text` is the whole text of the current turn so far. When that turn ends with a tool
 * call, its text was a preamble ("let me look"), and `reading` follows, naming every page read so far.
 */
export type ChatProgress = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'reading'; readonly paths: readonly string[] };

export type ChatRequest = {
  readonly instructions: string;
  /** Earlier answered turns, oldest first, as text only. */
  readonly history: readonly { readonly question: string; readonly answer: string }[];
  readonly question: string;
  /** The developer message of the last turn, the one with no tools. */
  readonly wrapUp: string;
  readonly reader: Reader;
  readonly limits: ChatLimits;
  readonly signal: AbortSignal;
  readonly now: () => number;
  readonly onProgress: (p: ChatProgress) => void;
};

/** How a question ran: model turns, and each tool call's name in order. */
export type ChatTrace = { readonly turns: number; readonly tools: readonly string[] };

export type ChatResult =
  /** `text` is the final turn's message as the endpoint finished it, not the joined deltas. `wrapped`: it came from the turn after the limits. */
  | { readonly kind: 'answered'; readonly text: string; readonly wrapped: boolean; readonly trace: ChatTrace }
  | { readonly kind: 'failed'; readonly reason: 'turns' | 'time' | 'empty' | 'rejected'; readonly detail: string; readonly trace: ChatTrace }
  | Unavailable
  | { readonly kind: 'cancelled' };

const developer = (text: string): InputItem => ({ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] });
const assistant = (text: string): InputItem => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

export async function runChat(model: Model, req: ChatRequest): Promise<ChatResult> {
  const input: InputItem[] = [...req.history.flatMap((qa) => [user(qa.question), assistant(qa.answer)]), user(req.question)];
  const start = req.now();
  const tools: string[] = [];
  const read: string[] = [];
  for (let turn = 1; ; turn++) {
    const spent = turn > req.limits.turns ? 'turns' : req.now() - start > req.limits.askMs ? 'time' : null;
    if (spent) input.push(developer(req.wrapUp));
    let text = '';
    const r = await model(
      {
        role: 'chat', profile: null, instructions: req.instructions, input: [...input], tools: spent ? [] : CHAT_TOOLS,
        onText: (delta) => req.onProgress({ kind: 'text', text: (text += delta) }),
      },
      req.signal,
    );
    const trace = { turns: turn, tools: [...tools] };
    if (!r.ok) return r.problem.kind === 'rejected' ? { kind: 'failed', reason: 'rejected', detail: r.problem.detail, trace } : r.problem;
    const calls = r.output.filter((o): o is FunctionCall => o.type === 'function_call');
    if (calls.length === 0) {
      return r.text.trim() ? { kind: 'answered', text: r.text, wrapped: spent !== null, trace } : { kind: 'failed', reason: spent ?? 'empty', detail: 'the model gave no answer', trace };
    }
    if (spent) return { kind: 'failed', reason: spent, detail: 'the model called a tool on its last turn', trace };
    input.push(...replay(r.output));
    for (const call of calls) {
      tools.push(call.name);
      const path = call.name === 'read' ? argsOf(call.arguments)?.path : undefined;
      if (typeof path === 'string' && !read.includes(path)) read.push(path);
      input.push(answer(call, ((await dispatchRead(req.reader, call)) ?? shown(`error: no tool named ${call.name}`)).text));
    }
    req.onProgress({ kind: 'reading', paths: [...read] });
  }
}
