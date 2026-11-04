/**
 * One model turn against the Codex backend: the Responses API at chatgpt.com, paid by the
 * user's ChatGPT plan. The request always streams, as the endpoint requires; the caller gets
 * text deltas as they come and the finished output items at the end.
 *
 * This file knows the wire: headers, event names, and how to tell a spent login or a rate
 * limit from a bad request. It knows nothing about wikis or tools beyond their JSON shape.
 */

import type { Fetch } from './auth';

export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const ORIGINATOR = 'darami';

export const EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;
export type Effort = (typeof EFFORTS)[number];

export type FunctionTool = {
  readonly type: 'function';
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly strict?: boolean;
};

export type InputContent =
  | { readonly type: 'input_text'; readonly text: string }
  | { readonly type: 'input_image'; readonly image_url: string };

export type InputItem =
  | { readonly type: 'message'; readonly role: 'user' | 'developer'; readonly content: readonly InputContent[] }
  | { readonly type: 'message'; readonly role: 'assistant'; readonly content: readonly { readonly type: 'output_text'; readonly text: string }[] }
  | FunctionCall
  | { readonly type: 'function_call_output'; readonly call_id: string; readonly output: string };

export type FunctionCall = { readonly type: 'function_call'; readonly call_id: string; readonly name: string; readonly arguments: string };

/** Output items the caller acts on. Reasoning and anything newer are kept only as opaque JSON. */
export type OutputItem =
  | { readonly type: 'message'; readonly text: string }
  | FunctionCall
  | { readonly type: 'other'; readonly raw: Record<string, unknown> };

export type TurnRequest = {
  readonly model: string;
  readonly instructions: string;
  readonly input: readonly InputItem[];
  readonly tools?: readonly FunctionTool[];
  readonly effort?: Effort;
  /** Ask for a final answer matching this JSON schema, instead of free text. */
  readonly schema?: { readonly name: string; readonly schema: Record<string, unknown> };
  readonly signal?: AbortSignal;
  readonly onText?: (delta: string) => void;
  /** Each piece of the stream as it arrives, text or not: a function call's arguments stream with no text delta. */
  readonly onChunk?: () => void;
};

export type Usage = { readonly inputTokens: number; readonly outputTokens: number };

export type ModelFailure =
  /** The access token was refused. Refresh, then log in again if that fails too. */
  | { readonly kind: 'unauthorized'; readonly detail: string }
  /** The plan's usage limit. Wait at least retryAfterMs before the next call. */
  | { readonly kind: 'rate-limited'; readonly retryAfterMs: number; readonly detail: string }
  /** The request itself is wrong: unknown model, bad schema, too long. Retrying will not help. */
  | { readonly kind: 'rejected'; readonly status: number; readonly detail: string }
  | { readonly kind: 'server'; readonly status: number; readonly detail: string }
  | { readonly kind: 'network'; readonly detail: string }
  | { readonly kind: 'cancelled' };

export type TurnResult =
  | { readonly ok: true; readonly output: readonly OutputItem[]; readonly text: string; readonly usage: Usage | null }
  | { readonly ok: false; readonly failure: ModelFailure };

export type Credentials = { readonly accessToken: string; readonly accountId: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const MINUTE = 60_000;

export function requestBody(req: TurnRequest): Record<string, unknown> {
  return {
    model: req.model,
    instructions: req.instructions,
    input: req.input,
    tools: req.tools ?? [],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    reasoning: req.effort ? { effort: req.effort } : null,
    store: false,
    stream: true,
    include: [],
    ...(req.schema ? { text: { format: { type: 'json_schema', name: req.schema.name, schema: req.schema.schema, strict: true } } } : {}),
  };
}

export function headers(c: Credentials): Record<string, string> {
  return {
    authorization: `Bearer ${c.accessToken}`,
    'chatgpt-account-id': c.accountId,
    'content-type': 'application/json',
    accept: 'text/event-stream',
    originator: ORIGINATOR,
  };
}

function detailOf(text: string): string {
  try {
    const j: unknown = JSON.parse(text);
    if (isRecord(j)) {
      const e = j.error ?? j.detail;
      if (isRecord(e) && typeof e.message === 'string') return e.message;
      if (typeof e === 'string') return e;
    }
  } catch {
    // Not JSON: the text itself is the detail.
  }
  return text.slice(0, 300);
}

/** How long a 429 asks us to wait: Retry-After, else the resets_in_seconds the backend sends, else five minutes. */
function retryAfterMs(res: { headers: { get(name: string): string | null } }, text: string, now: number): number {
  const header = res.headers.get('retry-after');
  if (header) {
    const s = Number(header);
    if (Number.isFinite(s)) return Math.max(MINUTE, s * 1000);
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(MINUTE, at - now);
  }
  const m = /"resets_in_seconds"\s*:\s*(\d+)/.exec(text);
  return m ? Math.max(MINUTE, Number(m[1]) * 1000) : 5 * MINUTE;
}

export function failureFromStatus(status: number, text: string, res: { headers: { get(name: string): string | null } }, now = Date.now()): ModelFailure {
  const detail = detailOf(text);
  if (status === 401 || status === 403) return { kind: 'unauthorized', detail };
  if (status === 429) return { kind: 'rate-limited', retryAfterMs: retryAfterMs(res, text, now), detail };
  if (status >= 500) return { kind: 'server', status, detail };
  return { kind: 'rejected', status, detail };
}

export function outputItem(raw: unknown): OutputItem | null {
  if (!isRecord(raw)) return null;
  if (raw.type === 'function_call' && typeof raw.call_id === 'string' && typeof raw.name === 'string') {
    return { type: 'function_call', call_id: raw.call_id, name: raw.name, arguments: typeof raw.arguments === 'string' ? raw.arguments : '{}' };
  }
  if (raw.type === 'message' && Array.isArray(raw.content)) {
    const text = raw.content
      .filter((c): c is Record<string, unknown> => isRecord(c) && c.type === 'output_text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('');
    return { type: 'message', text };
  }
  return { type: 'other', raw };
}

type SseEvent = { readonly event: string | null; readonly data: unknown };

export function createEventParser(): { push(text: string): SseEvent[]; end(): SseEvent[] } {
  let buffer = '';
  const parse = (block: string): SseEvent | null => {
    let event: string | null = null;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length === 0) return null;
    const joined = data.join('\n');
    if (joined === '[DONE]') return null;
    try {
      return { event, data: JSON.parse(joined) };
    } catch {
      return null;
    }
  };
  return {
    push(text) {
      buffer += text;
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? '';
      return blocks.map(parse).filter((e): e is SseEvent => e !== null);
    },
    end() {
      const last = buffer.trim() ? parse(buffer) : null;
      buffer = '';
      return last ? [last] : [];
    },
  };
}

/** Folds the event stream into a result. Exposed so recorded streams can be replayed in tests. */
export function createTurnCollector(onText?: (delta: string) => void) {
  const output: OutputItem[] = [];
  let text = '';
  let usage: Usage | null = null;
  let finished = false;
  let failure: ModelFailure | null = null;

  return {
    accept(e: SseEvent): void {
      const d = e.data;
      if (!isRecord(d)) return;
      const type = typeof d.type === 'string' ? d.type : e.event;
      if (type === 'response.output_text.delta' && typeof d.delta === 'string') {
        text += d.delta;
        onText?.(d.delta);
      } else if (type === 'response.output_item.done') {
        const item = outputItem(d.item);
        if (item) output.push(item);
      } else if (type === 'response.completed' || type === 'response.incomplete') {
        finished = true;
        const u = isRecord(d.response) && isRecord(d.response.usage) ? d.response.usage : null;
        if (u) usage = { inputTokens: Number(u.input_tokens) || 0, outputTokens: Number(u.output_tokens) || 0 };
      } else if (type === 'response.failed' || type === 'error') {
        const err = isRecord(d.response) && isRecord(d.response.error) ? d.response.error : isRecord(d.error) ? d.error : d;
        const code = typeof err.code === 'string' ? err.code : '';
        const message = typeof err.message === 'string' ? err.message : JSON.stringify(err).slice(0, 300);
        failure = /rate_limit|usage_limit/i.test(code)
          ? { kind: 'rate-limited', retryAfterMs: 5 * MINUTE, detail: message }
          : { kind: 'server', status: 200, detail: code ? `${code}: ${message}` : message };
      }
    },
    result(): TurnResult {
      if (failure) return { ok: false, failure };
      if (!finished) return { ok: false, failure: { kind: 'network', detail: 'the stream ended before response.completed' } };
      const messageText = output.filter((o) => o.type === 'message').map((o) => (o as { text: string }).text).join('\n\n');
      return { ok: true, output, text: messageText || text, usage };
    },
  };
}

export async function runTurn(fetchFn: Fetch, creds: Credentials, req: TurnRequest, baseUrl = CODEX_BASE_URL): Promise<TurnResult> {
  let res: Response;
  try {
    res = await fetchFn(`${baseUrl}/responses`, { method: 'POST', headers: headers(creds), body: JSON.stringify(requestBody(req)), signal: req.signal });
  } catch (e) {
    if (req.signal?.aborted) return { ok: false, failure: { kind: 'cancelled' } };
    return { ok: false, failure: { kind: 'network', detail: e instanceof Error ? e.message : String(e) } };
  }
  if (res.status < 200 || res.status >= 300) {
    const text = await res.text().catch(() => '');
    return { ok: false, failure: failureFromStatus(res.status, text, res) };
  }
  const collector = createTurnCollector(req.onText);
  const parser = createEventParser();
  try {
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        req.onChunk?.();
        parser.push(decoder.decode(value, { stream: true })).forEach(collector.accept);
      }
    } else {
      // A fetch without streaming bodies still gets the whole stream at once.
      parser.push(await res.text()).forEach(collector.accept);
    }
    parser.end().forEach(collector.accept);
  } catch (e) {
    if (req.signal?.aborted) return { ok: false, failure: { kind: 'cancelled' } };
    return { ok: false, failure: { kind: 'network', detail: e instanceof Error ? e.message : String(e) } };
  }
  return collector.result();
}
