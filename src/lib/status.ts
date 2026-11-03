/**
 * Why memos are or are not being filed right now: the memo tab's badge and the settings Filing
 * row both render this. Pure; the inputs are App fields.
 */

import type { FolderState } from '../core/wiki';
import type { Pause } from '../jobs/runner';
import { copy } from '../text';
import type { Login } from './login';

export type FilingStatus =
  | { readonly kind: 'login'; readonly waiting: number }
  | { readonly kind: 'folder'; readonly broken: boolean; readonly waiting: number }
  | { readonly kind: 'offline'; readonly waiting: number }
  | { readonly kind: 'limited'; readonly until: number; readonly waiting: number }
  /** The server or the model answered badly; it is tried again later. */
  | { readonly kind: 'trouble'; readonly waiting: number }
  | { readonly kind: 'filing'; readonly waiting: number }
  | { readonly kind: 'idle' };

/**
 * First match wins: the login, the folder, no network, a usage limit, the server or the model,
 * memos on their way, nothing. A pause whose time has passed counts as none. A folder still being
 * inspected is not a problem yet. `waiting` is the book's working count.
 */
export function filingStatus(a: {
  readonly login: Login;
  readonly folder: FolderState | null;
  readonly online: boolean | null;
  readonly paused: Pause | null;
  readonly waiting: number;
  readonly now: number;
}): FilingStatus {
  const { waiting } = a;
  const pause = a.paused && a.paused.until > a.now ? a.paused : null;
  if (a.login.kind !== 'in' || pause?.cause === 'login') return { kind: 'login', waiting };
  if (a.folder && a.folder.kind !== 'wiki') return { kind: 'folder', broken: a.folder.kind === 'broken', waiting };
  if (a.online === false || pause?.cause === 'network') return { kind: 'offline', waiting };
  if (pause?.cause === 'rate-limited') return { kind: 'limited', until: pause.until, waiting };
  if (pause) return { kind: 'trouble', waiting };
  return waiting > 0 ? { kind: 'filing', waiting } : { kind: 'idle' };
}

export type StatusLine = { readonly text: string; readonly tone: 'quiet' | 'warn'; readonly href: string | null };

const counted = (text: string, waiting: number) => (waiting > 0 ? `${text} · ${copy.status.waiting(waiting)}` : text);

/** The badge's words, its tone, and where a tap goes; null when there is nothing to say. */
export function statusLine(s: FilingStatus): StatusLine | null {
  switch (s.kind) {
    case 'login':
      return { text: counted(copy.status.login, s.waiting), tone: 'warn', href: '/onboarding?repair=login' };
    case 'folder':
      return { text: counted(copy.status.folder, s.waiting), tone: 'warn', href: s.broken ? '/settings' : '/onboarding?repair=folder' };
    case 'offline':
      return { text: counted(copy.status.offline, s.waiting), tone: 'warn', href: null };
    case 'limited':
      return { text: counted(copy.status.limited(new Date(s.until)), s.waiting), tone: 'warn', href: null };
    case 'trouble':
      return { text: counted(copy.status.trouble, s.waiting), tone: 'warn', href: null };
    case 'filing':
      return { text: copy.status.filing(s.waiting), tone: 'quiet', href: '/activity' };
    case 'idle':
      return null;
  }
}
