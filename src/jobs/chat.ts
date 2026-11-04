/**
 * Chat with the wiki: a question to a stored turn, and the page viewer's read. Built only by
 * engine.ts, which hands it `committed`, the journal's committed view, and never the Fs, the
 * journal, or a JobTx. So "a chat changes no file" holds three ways: the type it gets has no method
 * that writes, the object it gets has none at runtime, and boundary.test.ts fails if this file
 * calls write, create, or remove, or imports a module that writes the folder. Its one writer is the
 * chats store, which is SQLite, not the folder.
 *
 * Outside every lane: reads go through the committed view, so a question never waits behind an
 * ingest and never sees one half done.
 */

import {
  answerDomain, answerId, chatInstructions, chatTitle, citationsOf, historyOf, linkedDomains, linkRef, linksOf, rememberId, targetKey, targetOf, type ChatId,
} from '../core/chat';
import type { ConfigParse, ConfigProblem } from '../core/config';
import type { ReadFs } from '../core/fs';
import { chatPlaceOf, paths, resolvePath, ROOT, type WikiPath } from '../core/layout';
import { indexEntries, pageMeta, pageRefString, splitFrontmatter, type PageRef } from '../core/pages';
import { textFor } from '../core/text';
import type { AnswerId, ChatTarget, DomainName, MemoId } from '../core/types';
import { composeSystemPrompt } from '../core/wiki';
import { CHAT_LIMITS, runChat, type ChatLimits, type ChatProgress, type ChatTrace } from '../agent/loop';
import type { Model } from '../agent/model';
import { chatReader } from './workspace';

/** Why a stored turn has no answer: the loop's failure, or the model being unavailable. A word this code never wrote reads as `other`. */
export const CHAT_FAILURES = ['rate-limited', 'login', 'model', 'server', 'network', 'turns', 'time', 'empty', 'rejected', 'other'] as const;
export type ChatFailure = (typeof CHAT_FAILURES)[number];

/** One stored turn. An aborted turn is never stored. */
export type TurnRecord = {
  readonly chat: ChatId;
  /** Counted from 0 with no gaps, failed turns included: answerId(chat, n) names its saved answer. */
  readonly n: number;
  /** targetKey(): null for every domain. The same on every turn of a chat. */
  readonly target: string | null;
  readonly askedAt: string;
  readonly at: string;
  readonly question: string;
  readonly outcome:
    /** `cited`: pageRefString of each citation, in order. */
    | { readonly kind: 'answered'; readonly answer: string; readonly cited: readonly string[] }
    | { readonly kind: 'failed'; readonly failure: ChatFailure };
};

/** A chat as the list shows it, derived from its turns: there is no chat row. */
export type ChatRow = { readonly chat: ChatId; readonly target: string | null; readonly createdAt: string; readonly updatedAt: string; readonly turns: number; readonly first: string };

/** One wiki folder's chats: sqliteChats(folder) on the phone, memoryChats() under jest. */
export type ChatStore = {
  /** Newest updated first; ties by chat id, descending. */
  chats(): Promise<readonly ChatRow[]>;
  /** In n order. [] for a chat that does not exist. */
  turns(chat: ChatId): Promise<readonly TurnRecord[]>;
  /** Throws when (chat, n) exists. The first turn makes the chat. */
  add(turn: TurnRecord): Promise<void>;
  /** Every turn of the chat. Never touches the wiki: saved answers and remembered memos stay. */
  forget(chat: ChatId): Promise<void>;
};

/** A stored turn as the screens show it. `cited`, `links`, `saveTo`, `answerId`, and `memo` are derived, never stored. */
export type AnsweredTurn = {
  readonly kind: 'answered';
  readonly n: number;
  readonly askedAt: string;
  readonly question: string;
  readonly answer: string;
  /** Pages on disk when the answer came, first cited first. One of a domain no longer declared is dropped. */
  readonly cited: readonly PageRef[];
  /** Which inline [[links]], as written, open the viewer: those that name a citation. */
  readonly links: ReadonlyMap<string, PageRef>;
  /** Where Save answer files it. null: no button. */
  readonly saveTo: DomainName | null;
  /** The key of its save state in MemoBook.answers. */
  readonly answerId: AnswerId;
  /** Remember's memo id: the question is remembered when the memo book has it. */
  readonly memo: MemoId;
};
export type FailedTurn = { readonly kind: 'failed'; readonly n: number; readonly askedAt: string; readonly question: string; readonly failure: ChatFailure; readonly memo: MemoId };
export type ChatTurn = AnsweredTurn | FailedTurn;

export type ChatView = { readonly id: ChatId; readonly target: ChatTarget; readonly turns: readonly ChatTurn[] };
export type ChatSummary = { readonly id: ChatId; readonly target: ChatTarget; readonly title: string; readonly createdAt: string; readonly updatedAt: string; readonly turns: number };

export type Question = { readonly chat: ChatId; readonly target: ChatTarget; readonly text: string };

/** How the question ran, for the dev log. `wrapped`: the answer came from the turn after the limits. */
export type AskTrace = ChatTrace & { readonly wrapped: boolean };

export type AskResult =
  | { readonly kind: 'answered'; readonly turn: AnsweredTurn; readonly trace: AskTrace }
  /** Stored. `retryAt` (epoch ms) for a usage limit. `trace` null: the model was unavailable. */
  | { readonly kind: 'failed'; readonly turn: FailedTurn; readonly retryAt: number | null; readonly trace: AskTrace | null }
  /** Nothing stored. `busy`: a question runs on this chat; `other-target`: the chat asks another target. */
  | { readonly kind: 'cancelled' | 'busy' | 'other-target' | 'no-domain' | 'blank' }
  | { readonly kind: 'paused'; readonly problems: readonly ConfigProblem[] };

export type Chats = {
  /** One question: streams through onProgress, stores the turn, answers it. Never changes a file. */
  ask(q: Question, onProgress: (p: ChatProgress) => void, signal: AbortSignal): Promise<AskResult>;
  list(): Promise<readonly ChatSummary[]>;
  /** null for no such chat, or one whose domain is no longer declared: it is kept and shows again if the domain comes back. */
  open(id: ChatId): Promise<ChatView | null>;
  /** Stops a question running on it first, so a deleted chat never gets a late turn. */
  remove(id: ChatId): Promise<void>;
};

export type PageView = {
  readonly ref: PageRef;
  /** Under wiki/ without `.md`: `개념/RAG`. */
  readonly path: string;
  readonly type: string | null;
  readonly summary: string;
  readonly updated: string | null;
  /** The text after the frontmatter. */
  readonly body: string;
  /** Each link in the body, as written, to the page it names. */
  readonly links: ReadonlyMap<string, PageRef>;
};

export type ChatDeps = {
  /** The journal's committed view. Not called fs, a name boundary.test keeps for the engine's own folder. */
  readonly committed: ReadFs;
  readonly store: ChatStore;
  readonly model: Model;
  /** The engine's config(), so a read here also feeds the memo book. */
  readonly config: () => Promise<ConfigParse>;
  readonly now: () => Date;
  readonly limits?: ChatLimits;
};

const declaredOf = (c: ConfigParse): readonly DomainName[] | null => (c.ok ? [...c.config.domains.keys()] : null);

type Outcome<K extends TurnRecord['outcome']['kind']> = Extract<TurnRecord['outcome'], { readonly kind: K }>;
const commonOf = (r: TurnRecord) => ({ n: r.n, askedAt: r.askedAt, question: r.question, memo: rememberId(r.chat, r.n) });

function answeredView(r: TurnRecord, o: Outcome<'answered'>, target: ChatTarget, declared: readonly DomainName[]): AnsweredTurn {
  const cited = o.cited.flatMap((s) => linkRef(s, null, declared) ?? []);
  const from = target.kind === 'domain' ? target.domain : null;
  return { kind: 'answered', ...commonOf(r), answer: o.answer, cited, links: linksOf(o.answer, from, declared, cited), saveTo: answerDomain(target, cited), answerId: answerId(r.chat, r.n) };
}

const failedView = (r: TurnRecord, o: Outcome<'failed'>): FailedTurn => ({ kind: 'failed', ...commonOf(r), failure: o.failure });

const viewOf = (r: TurnRecord, target: ChatTarget, declared: readonly DomainName[]): ChatTurn =>
  r.outcome.kind === 'answered' ? answeredView(r, r.outcome, target, declared) : failedView(r, r.outcome);

export function chatService(deps: ChatDeps): { readonly chats: Chats; page(ref: PageRef): Promise<PageView | null> } {
  const { committed, store } = deps;
  const claims = new Map<ChatId, { readonly abort: AbortController; readonly done: Promise<void> }>();

  async function asked(q: Question, text: string, onProgress: (p: ChatProgress) => void, signal: AbortSignal): Promise<AskResult> {
    const c = await deps.config();
    if (!c.ok) return { kind: 'paused', problems: c.problems };
    const declared = [...c.config.domains.keys()];
    if (q.target.kind === 'domain' && !declared.includes(q.target.domain)) return { kind: 'no-domain' };
    const rows = await store.turns(q.chat);
    if (rows[0] && rows[0].target !== targetKey(q.target)) return { kind: 'other-target' };
    const n = rows.length ? rows.at(-1)!.n + 1 : 0;
    const askedAt = deps.now().toISOString();
    const t = textFor(c.config.locale);
    const prompt = q.target.kind === 'root' ? ((await committed.readText(paths.rootSchema)) ?? '') : await composeSystemPrompt(committed, paths.domainSchema(q.target.domain));
    const reader = chatReader({ fs: committed, target: q.target, declared });
    const out = await runChat(deps.model, {
      instructions: chatInstructions({ target: q.target, prompt, config: c.config, t }),
      history: historyOf(rows.map((r) => ({ question: r.question, answer: r.outcome.kind === 'answered' ? r.outcome.answer : null }))),
      question: text,
      wrapUp: t.chat.wrapUp,
      reader,
      limits: deps.limits ?? CHAT_LIMITS,
      signal,
      now: () => deps.now().getTime(),
      onProgress,
    });
    if (out.kind === 'cancelled' || signal.aborted) return { kind: 'cancelled' };
    const base = { chat: q.chat, n, target: targetKey(q.target), askedAt, at: deps.now().toISOString(), question: text };
    if (out.kind === 'answered') {
      const cited = citationsOf(out.text, q.target, await reader.pageNames(linkedDomains(out.text, q.target, declared)), declared);
      const outcome: Outcome<'answered'> = { kind: 'answered', answer: out.text, cited: cited.map(pageRefString) };
      const record: TurnRecord = { ...base, outcome };
      await store.add(record);
      return { kind: 'answered', turn: answeredView(record, outcome, q.target, declared), trace: { ...out.trace, wrapped: out.wrapped } };
    }
    const outcome: Outcome<'failed'> = { kind: 'failed', failure: out.kind === 'unavailable' ? out.cause : out.reason };
    const record: TurnRecord = { ...base, outcome };
    await store.add(record);
    return {
      kind: 'failed',
      turn: failedView(record, outcome),
      retryAt: out.kind === 'unavailable' && out.cause === 'rate-limited' ? deps.now().getTime() + out.retryAfterMs : null,
      trace: out.kind === 'failed' ? { ...out.trace, wrapped: false } : null,
    };
  }

  /** The file a page ref opens: `<d>/wiki/<page>.md`, else a basename in index.md, else in the wiki tree. Only under that wiki. */
  async function pageAt(ref: PageRef, declared: readonly DomainName[]): Promise<{ readonly path: WikiPath; readonly text: string } | null> {
    const wiki = paths.wiki(ref.domain);
    const inWiki = (p: WikiPath | null): p is WikiPath => p !== null && p.startsWith(`${wiki}/`) && chatPlaceOf({ kind: 'root' }, declared, p).kind === 'readable';
    const at = async (p: WikiPath | null) => {
      const text = inWiki(p) ? await committed.readText(p) : null;
      return text === null ? null : { path: p as WikiPath, text };
    };
    const direct = await at(resolvePath(ROOT, `${wiki}/${ref.page}.md`));
    if (direct || ref.page.includes('/')) return direct;
    const named = (stem: string) => stem.split('/').pop() === ref.page;
    const index = await committed.readText(paths.index(ref.domain));
    const listed = indexEntries(index ?? '').flatMap((e) => linkRef(e.target, ref.domain, declared) ?? []).find((r) => r.domain === ref.domain && named(r.page));
    const fromIndex = listed ? await at(resolvePath(ROOT, `${wiki}/${listed.page}.md`)) : null;
    if (fromIndex) return fromIndex;
    const found = (await committed.listTree(wiki)).find((p) => p.endsWith('.md') && named(p.slice(wiki.length + 1, -3)));
    return found ? at(found) : null;
  }

  return {
    chats: {
      async ask(q, onProgress, signal) {
        const text = q.text.trim();
        if (!text) return { kind: 'blank' };
        if (claims.has(q.chat)) return { kind: 'busy' };
        const abort = new AbortController();
        const follow = () => abort.abort();
        signal.addEventListener('abort', follow);
        if (signal.aborted) abort.abort();
        let settle = () => {};
        claims.set(q.chat, { abort, done: new Promise<void>((r) => (settle = r)) });
        try {
          return await asked(q, text, onProgress, abort.signal);
        } finally {
          signal.removeEventListener('abort', follow);
          claims.delete(q.chat);
          settle();
        }
      },

      async list() {
        const declared = declaredOf(await deps.config());
        return (await store.chats()).flatMap((r): ChatSummary[] => {
          const target = targetOf(r.target, declared);
          return target ? [{ id: r.chat, target, title: chatTitle(r.first), createdAt: r.createdAt, updatedAt: r.updatedAt, turns: r.turns }] : [];
        });
      },

      async open(id) {
        const rows = await store.turns(id);
        if (!rows[0]) return null;
        const declared = declaredOf(await deps.config());
        const target = targetOf(rows[0].target, declared);
        return target ? { id, target, turns: rows.map((r) => viewOf(r, target, declared ?? [])) } : null;
      },

      async remove(id) {
        const claim = claims.get(id);
        claim?.abort.abort();
        await claim?.done;
        await store.forget(id);
      },
    },

    async page(ref) {
      const declared = declaredOf(await deps.config());
      if (!declared?.includes(ref.domain)) return null;
      const found = await pageAt(ref, declared);
      if (!found) return null;
      const under = found.path.slice(paths.wiki(ref.domain).length + 1);
      const meta = pageMeta(under, found.text);
      const { data, body } = splitFrontmatter(found.text);
      return {
        ref,
        path: under.replace(/\.md$/, ''),
        type: meta.type,
        summary: meta.summary,
        updated: typeof data?.updated === 'string' ? data.updated : null,
        body,
        links: linksOf(body, ref.domain, declared, null),
      };
    },
  };
}

