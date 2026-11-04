/** What the chat screens show for the engine's chat results. Pure but for the copy table; state.ts and the screens call it. */

import { pageRefString, type PageRef } from '../core/pages';
import type { ChatTarget } from '../core/types';
import type { AnswerPlacement, AskResult, SaveResult } from '../jobs/engine';
import { copy } from '../text';
import { pageLabel } from './markdown';

/** A question as the screen sees it: the engine's answer, or why no engine could be asked. */
export type Asked = AskResult | { readonly kind: 'no-wiki' } | { readonly kind: 'unreachable' } | { readonly kind: 'error'; readonly message: string };

/** A save as the screen sees it. `failed`: the folder threw part way; saving again finishes it. */
export type Saved = SaveResult | { readonly kind: 'no-wiki' } | { readonly kind: 'failed'; readonly message: string };

export const targetLabel = (t: ChatTarget): string => (t.kind === 'root' ? copy.common.all : t.domain);

export const sameTarget = (a: ChatTarget, b: ChatTarget): boolean => (a.kind === 'root' ? b.kind === 'root' : b.kind === 'domain' && b.domain === a.domain);

/** The note for a question that kept no turn; null when it kept one or was stopped. */
export function refusedText(r: Asked): string | null {
  switch (r.kind) {
    case 'answered':
    case 'failed':
    case 'cancelled':
      return null;
    default:
      return copy.chat.refused[r.kind];
  }
}

/** Save answer's button. `opens`: the saved page a tap shows; `saves`: a tap saves. */
export type SaveButton = { readonly label: string; readonly on: boolean; readonly saves: boolean; readonly opens: PageRef | null };

export function saveButton(placed: AnswerPlacement | undefined, saving: boolean): SaveButton {
  const idle = { on: false, saves: false, opens: null };
  if (saving) return { ...idle, label: copy.common.saving };
  if (!placed) return { ...idle, label: copy.chat.saveAnswer, saves: true };
  switch (placed.state) {
    case 'staged':
      return { ...idle, label: copy.chat.staging(placed.domain) };
    case 'saved':
      return { ...idle, label: copy.chat.saved, on: true, opens: { domain: placed.domain, page: placed.page } };
    case 'gave-up':
      return { ...idle, label: copy.chat.saveGaveUp };
  }
}

/** The note a save shows; null when the button says enough. */
export function savedText(r: Saved): string | null {
  switch (r.kind) {
    case 'staged':
    case 'duplicate':
      return null;
    case 'refused':
      return r.reason.kind === 'missing-page' ? copy.chat.saveRefused['missing-page'](pageLabel(r.reason.page)) : copy.chat.saveRefused[r.reason.kind];
    case 'no-wiki':
    case 'failed':
      return copy.chat.saveRefused[r.kind];
  }
}

/** The last three pages read, or the wiki before any. */
export const readingText = (paths: readonly string[]): string =>
  paths.length ? copy.chat.readingPages(paths.slice(-3).map((p) => pageLabel(p.replace(/\.md$/, ''))).join(', ')) : copy.chat.reading;

/**
 * The dev build's logcat line for one question:
 *   CHAT <outcome> turns=<n> tools=<a,b|-> ms=<total> first=<ms to first text|-> wrapped=<yes|no> target=<root|domain> cited=<d/wiki/p|…|->
 * target and cited come last because a domain or a page name can hold spaces.
 */
export function chatLogLine(r: Asked, a: { readonly target: ChatTarget; readonly ms: number; readonly firstTextMs: number | null }): string {
  const trace = r.kind === 'answered' || r.kind === 'failed' ? r.trace : null;
  const cited = r.kind === 'answered' ? r.turn.cited.map(pageRefString).join('|') : '';
  return [
    `CHAT ${r.kind === 'failed' ? `failed:${r.turn.failure}` : r.kind}`,
    `turns=${trace?.turns ?? 0}`,
    `tools=${trace?.tools.join(',') || '-'}`,
    `ms=${a.ms}`,
    `first=${a.firstTextMs ?? '-'}`,
    `wrapped=${trace?.wrapped ? 'yes' : 'no'}`,
    `target=${a.target.kind === 'root' ? 'root' : a.target.domain}`,
    `cited=${cited || '-'}`,
  ].join(' ');
}
