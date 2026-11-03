/**
 * The ChatGPT login as the screens show it. Pure; state.ts holds the one Login and is its only writer.
 */

import type { AuthFailure } from '../codex/auth';
import type { Session } from '../codex/session';
import { copy } from '../text';

export type Login =
  | { readonly kind: 'out' }
  | { readonly kind: 'in'; readonly email: string | null; readonly plan: string | null }
  /** Memos still go in and wait; filing resumes once the user logs in again. */
  | { readonly kind: 'expired'; readonly email: string | null };

/**
 * `refused`: this launch, a model call answered 401 even after a forced refresh, while the tokens
 * are still stored. Kept in memory like the runner's pause: a relaunch costs one more 401 to learn it.
 */
export function loginOf(s: Session, refused: boolean): Login {
  switch (s.kind) {
    case 'tokens':
      return refused ? { kind: 'expired', email: s.tokens.email } : { kind: 'in', email: s.tokens.email, plan: s.tokens.plan };
    case 'lost':
      return { kind: 'expired', email: s.email };
    case 'none':
      return { kind: 'out' };
  }
}

/** The login step's sentence for a failed attempt; null for a cancel, which only goes back to the start. */
export function loginFailureText(f: AuthFailure): string | null {
  switch (f.kind) {
    case 'cancelled':
      return null;
    case 'device-login-disabled':
      return copy.login.failed.disabled;
    case 'expired':
      return copy.login.failed.expired;
    case 'network':
      return copy.login.failed.network;
    case 'login-again':
    case 'http':
    case 'malformed':
      return copy.login.failed.other;
  }
}
