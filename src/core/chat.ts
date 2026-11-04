/**
 * The rules of a chat that are values, not I/O: ids, titles, history, the instructions, and which
 * [[links]] of an answer are citations. Pure, like pages.ts and filing.ts; jobs/chat.ts reads the
 * folder and hands this module strings and names.
 */

import { renderDomainCatalog, renderPageTypes, type WikiConfig } from './config';
import { extractWikilinks, linkResolves, pageRefString, parseAnswerId, parseMemoId, type PageNameIndex, type PageRef } from './pages';
import type { Text } from './text';
import type { AnswerId, ChatTarget, DomainName, MemoId } from './types';

/** A lower-case UUID the chat screen mints for a new chat, like a draft's memo id. Minted only by parseChatId. */
export type ChatId = string & { readonly __brand: 'ChatId' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseChatId(s: string): ChatId | null {
  const t = s.trim().toLowerCase();
  return UUID.test(t) ? (t as ChatId) : null;
}

/**
 * Save answer's id for turn `n`: dotoriwiki's answerId, so a second save of the same turn is the
 * ledger's or the staging file's duplicate. The chat's first 24 characters, then `n` as 12 hex digits.
 */
export const answerId = (chat: ChatId, n: number): AnswerId => parseAnswerId(`${chat.slice(0, 24)}${n.toString(16).padStart(12, '0')}`)!;

/** Above every answerId's turn digits, so Remember's ids never meet Save answer's, which share the prefix. */
const REMEMBER_BIT = 0x8000_0000_0000;

/** Remember's memo id for turn `n`: fixed, so a second tap is accept's duplicate and "remembered" is read from the memo book. */
export const rememberId = (chat: ChatId, n: number): MemoId => parseMemoId(`${chat.slice(0, 24)}${(REMEMBER_BIT + n).toString(16)}`)!;

/** dotoriwiki's chat title: the first question, whitespace collapsed, 40 code points (39 and `…` when cut). */
export function chatTitle(firstQuestion: string): string {
  const cps = Array.from(firstQuestion.replace(/\s+/g, ' ').trim());
  return cps.length > 40 ? `${cps.slice(0, 39).join('')}…` : cps.join('');
}

/** How a stored chat names its target: null for every domain, else the domain folder. */
export const targetKey = (t: ChatTarget): string | null => (t.kind === 'root' ? null : t.domain);

/** A stored key back as a target, or null for a domain no longer declared. `declared` null takes the key as written. */
export function targetOf(key: string | null, declared: readonly DomainName[] | null): ChatTarget | null {
  if (key === null) return { kind: 'root' };
  const domain = declared ? declared.find((d) => d === key) : (key as DomainName);
  return domain ? { kind: 'domain', domain } : null;
}

/**
 * The page a normalized `[[link]]` names. From a domain (`from`), dotoriwiki's parsePageRef:
 * `d/wiki/p` with d declared names d's page p, anything else a page of `from`. From a root chat
 * (`from` null), only `d/wiki/p` with d declared names a page. The page stays as written, so a
 * basename stays a basename.
 */
export function linkRef(link: string, from: DomainName | null, domains: readonly DomainName[]): PageRef | null {
  const m = /^(.+?)\/wiki\/(.+)$/.exec(link);
  const domain = m ? domains.find((d) => d === m[1]) : undefined;
  if (domain) return { domain, page: m![2]! };
  return from ? { domain: from, page: link } : null;
}

const fromOf = (target: ChatTarget): DomainName | null => (target.kind === 'domain' ? target.domain : null);

/**
 * dotoriwiki's citations(): the answer's links (code skipped) that name a page `names` knows,
 * deduped by `d/wiki/p`, first seen first. Computed from the text, never taken from the model.
 */
export function citationsOf(answer: string, target: ChatTarget, names: PageNameIndex, domains: readonly DomainName[]): readonly PageRef[] {
  const out = new Map<string, PageRef>();
  for (const link of extractWikilinks(answer)) {
    const ref = linkRef(link, fromOf(target), domains);
    const key = ref ? pageRefString(ref) : null;
    if (ref && key && !out.has(key) && linkResolves(key, ref.domain, names)) out.set(key, ref);
  }
  return [...out.values()];
}

/** The domains the answer's links name, for the names citationsOf needs. */
export function linkedDomains(answer: string, target: ChatTarget, domains: readonly DomainName[]): readonly DomainName[] {
  return [...new Set(extractWikilinks(answer).flatMap((l) => linkRef(l, fromOf(target), domains)?.domain ?? []))];
}

/**
 * Each link in `text` as written (linkTarget) → the page it opens. With `known`, only links to one
 * of those pages, as an answer's citations; with null, every link that names a page.
 */
export function linksOf(text: string, from: DomainName | null, domains: readonly DomainName[], known: readonly PageRef[] | null): ReadonlyMap<string, PageRef> {
  const keys = known ? new Set(known.map(pageRefString)) : null;
  const out = new Map<string, PageRef>();
  for (const link of extractWikilinks(text)) {
    const ref = linkRef(link, from, domains);
    if (ref && (!keys || keys.has(pageRefString(ref)))) out.set(link, ref);
  }
  return out;
}

/** Where Save answer files a turn: the chat's domain, or for a root chat the domain of its first citation. null: no button. */
export const answerDomain = (target: ChatTarget, cited: readonly PageRef[]): DomainName | null =>
  target.kind === 'domain' ? target.domain : (cited[0]?.domain ?? null);

export const HISTORY_CHARS = 40_000;

export type QA = { readonly question: string; readonly answer: string };

/** Earlier answered turns as the model gets them, text only: the newest that fit under HISTORY_CHARS, oldest first. */
export function historyOf(turns: readonly { readonly question: string; readonly answer: string | null }[]): readonly QA[] {
  const out: QA[] = [];
  let chars = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const { question, answer } = turns[i]!;
    if (answer === null) continue;
    chars += question.length + answer.length;
    if (chars > HISTORY_CHARS) break;
    out.unshift({ question, answer });
  }
  return out;
}

/**
 * dotoriwiki's chatContext and chat rules, then the in-app tools.
 *   root    the root CLAUDE.md as written (no `@` inlining), then the domain catalog
 *   domain  composeSystemPrompt(<d>/CLAUDE.md), then the domain's page types
 */
export function chatInstructions(a: { readonly target: ChatTarget; readonly prompt: string; readonly config: WikiConfig; readonly t: Text }): string {
  const domain = fromOf(a.target);
  const dc = domain ? a.config.domains.get(domain) : undefined;
  return [a.prompt, dc ? renderPageTypes(dc, a.t) : renderDomainCatalog(a.config, a.t), a.t.chat.rules(domain), a.t.chat.workspace(domain)].join('\n\n');
}
