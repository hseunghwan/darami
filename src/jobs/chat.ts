/**
 * Chat with the wiki: a question to a stored turn, and the page viewer's read.
 */

import type { ChatId } from '../core/chat';

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
  remove(chat: ChatId): Promise<void>;
};
