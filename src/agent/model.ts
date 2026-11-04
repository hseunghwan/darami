/**
 * The Model port the engine and the tool loop call, the models P3 runs, and the map from the Codex
 * client's failures to "unavailable", which never spends an attempt. Pure: credentials, runTurn,
 * and the timer are injected, so jest tests the refresh and the mapping with fakes; agent/codex.ts
 * binds the real ones for the phone.
 *
 * The wire shapes (InputItem, OutputItem, FunctionTool) appear here and in agent/loop.ts only.
 */

import type { Credentials, Effort, FunctionTool, InputItem, ModelFailure, OutputItem, TurnRequest, TurnResult } from '../codex/responses';
import type { ModelProfile } from '../core/config';
import { classifySchema, parseClassification, type Classification } from '../core/filing';
import type { DomainName } from '../core/types';

export type ModelRole = 'classify' | 'ingest' | 'chat';

export type ModelRequest = {
  readonly role: ModelRole;
  /** The domain's model_profile for ingest; null runs on the default. */
  readonly profile: ModelProfile | null;
  readonly instructions: string;
  readonly input: readonly InputItem[];
  readonly tools?: readonly FunctionTool[];
  readonly schema?: { readonly name: string; readonly schema: Record<string, unknown> };
  /** Each text delta of the turn as it streams. Tool-calling turns send them too. */
  readonly onText?: (delta: string) => void;
};

/**
 * Trouble with the service or the login, never with the job: nothing is written, no attempt is
 * spent, and the runner holds all model work until `retryAfterMs` has passed. A login pause also
 * ends when the user logs in again, and a network or server pause when the network comes back.
 */
export type Unavailable = {
  readonly kind: 'unavailable';
  readonly cause: 'rate-limited' | 'login' | 'model' | 'server' | 'network';
  readonly detail: string;
  readonly retryAfterMs: number;
};

export type ModelProblem =
  | Unavailable
  /** A request the endpoint refuses that waiting will not fix, such as one too long: the attempt fails with `llm`. */
  | { readonly kind: 'rejected'; readonly detail: string }
  /** The caller aborted: the app left the foreground. */
  | { readonly kind: 'cancelled' };

export type ModelTurn =
  | { readonly ok: true; readonly output: readonly OutputItem[]; readonly text: string }
  | { readonly ok: false; readonly problem: ModelProblem };

export type Model = (req: ModelRequest, signal: AbortSignal) => Promise<ModelTurn>;

export type ModelChoice = { readonly model: string; readonly effort: Effort };

/**
 * Only gpt-6-luna was measured on the phone (classify 3.3 s at low effort, a tool turn 1.5 s).
 * `ingest` is keyed by model_profile, and MODEL_PROFILES is its key set, so a profile added here
 * stops warning with no second list to edit. Chat ignores model_profile, as dotoriwiki's did, and
 * runs at low effort because someone is waiting for the first word.
 */
export const MODELS = {
  classify: { model: 'gpt-6-luna', effort: 'low' },
  chat: { model: 'gpt-6-luna', effort: 'low' },
  ingest: { default: { model: 'gpt-6-luna', effort: 'medium' } },
} as const satisfies { readonly classify: ModelChoice; readonly chat: ModelChoice; readonly ingest: { readonly default: ModelChoice } };

export const MODEL_PROFILES: ReadonlySet<string> = new Set(Object.keys(MODELS.ingest));

export function choiceFor(role: ModelRole, profile: ModelProfile | null): ModelChoice {
  const ingest: Readonly<Record<string, ModelChoice>> = MODELS.ingest;
  if (role === 'classify' || role === 'chat') return MODELS[role];
  return (profile && ingest[profile]) || MODELS.ingest.default;
}

const MINUTE = 60_000;
/** A turn whose stream sends nothing for this long is a stalled server, not a bad job. */
export const TURN_STALL_MS = 2 * MINUTE;
const NOT_SUPPORTED = /not supported|model_not_found|unsupported model|does not exist/i;

const unavailable = (cause: Unavailable['cause'], detail: string, retryAfterMs: number): Unavailable => ({ kind: 'unavailable', cause, detail, retryAfterMs });

/** dotoriwiki's codex timings: a usage limit waits as the endpoint says, a login or model problem 10 min, the server or network 2 min. */
export function problemOf(f: ModelFailure, stalled: boolean): ModelProblem {
  if (stalled) return unavailable('server', `the stream sent nothing for ${TURN_STALL_MS / MINUTE} min`, 2 * MINUTE);
  switch (f.kind) {
    case 'rate-limited': return unavailable('rate-limited', f.detail, f.retryAfterMs);
    case 'unauthorized': return unavailable('login', f.detail, 10 * MINUTE);
    case 'rejected': return NOT_SUPPORTED.test(f.detail) ? unavailable('model', f.detail, 10 * MINUTE) : { kind: 'rejected', detail: `${f.status} ${f.detail}` };
    case 'server': return unavailable('server', f.detail, 2 * MINUTE);
    case 'network': return unavailable('network', f.detail, 2 * MINUTE);
    case 'cancelled': return { kind: 'cancelled' };
  }
}

/** What codex/session.ts credentials() answers, by shape, so this file does not load expo-secure-store. */
export type CredentialsAnswer =
  | { readonly ok: true; readonly creds: Credentials }
  | { readonly ok: false; readonly failure: { readonly kind: string; readonly detail?: string } };

function loginProblem(f: { readonly kind: string; readonly detail?: string }): Unavailable {
  if (f.kind === 'logged-out' || f.kind === 'login-again') return unavailable('login', f.kind, 10 * MINUTE);
  if (f.kind === 'network') return unavailable('network', f.detail ?? 'network', 2 * MINUTE);
  return unavailable('server', `token refresh: ${f.kind}${f.detail ? ` ${f.detail}` : ''}`, 2 * MINUTE);
}

export type CodexDeps = {
  readonly credentials: (opts: { readonly force?: boolean }) => Promise<CredentialsAnswer>;
  readonly runTurn: (creds: Credentials, req: TurnRequest) => Promise<TurnResult>;
  /** Returns a cancel function. */
  readonly setTimer: (ms: number, fire: () => void) => () => void;
};

/** The Model over the Codex endpoint. A 401 gets one forced refresh and one more try before it reads as a login problem. */
export function codexModel(deps: CodexDeps): Model {
  return async (req, signal) => {
    const choice = choiceFor(req.role, req.profile);
    const turn = async (creds: Credentials): Promise<{ readonly r: TurnResult; readonly stalled: boolean }> => {
      const abort = new AbortController();
      let stalled = false;
      let cancel = () => {};
      const arm = () => {
        cancel();
        cancel = deps.setTimer(TURN_STALL_MS, () => {
          stalled = true;
          abort.abort();
        });
      };
      const follow = () => abort.abort();
      signal.addEventListener('abort', follow);
      if (signal.aborted) abort.abort();
      arm();
      try {
        const r = await deps.runTurn(creds, { ...choice, instructions: req.instructions, input: req.input, tools: req.tools, schema: req.schema, signal: abort.signal, onText: req.onText, onChunk: arm });
        return { r, stalled };
      } finally {
        cancel();
        signal.removeEventListener('abort', follow);
      }
    };
    const c = await deps.credentials({});
    if (!c.ok) return { ok: false, problem: loginProblem(c.failure) };
    let t = await turn(c.creds);
    if (!t.r.ok && t.r.failure.kind === 'unauthorized' && !signal.aborted) {
      const fresh = await deps.credentials({ force: true });
      if (!fresh.ok) return { ok: false, problem: loginProblem(fresh.failure) };
      t = await turn(fresh.creds);
    }
    if (t.r.ok) return { ok: true, output: t.r.output, text: t.r.text };
    return { ok: false, problem: signal.aborted ? { kind: 'cancelled' } : problemOf(t.r.failure, t.stalled) };
  };
}

/**
 * One classify try: one strict-schema turn with no tools. A refused request or an unusable answer
 * is a failed try; the router allows CLASSIFY_TRIES of them, then holds the memo in fallback_domain.
 */
export async function classify(
  model: Model,
  req: { readonly instructions: string; readonly text: string; readonly domains: readonly DomainName[] },
  signal: AbortSignal,
): Promise<Classification | Unavailable | { readonly kind: 'cancelled' }> {
  const r = await model(
    {
      role: 'classify',
      profile: null,
      instructions: req.instructions,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: req.text }] }],
      schema: classifySchema(req.domains),
    },
    signal,
  );
  if (!r.ok) return r.problem.kind === 'rejected' ? { kind: 'no-answer', detail: r.problem.detail } : r.problem;
  return parseClassification(r.text, req.domains);
}
