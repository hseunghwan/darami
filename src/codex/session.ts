/**
 * The logged-in ChatGPT session: tokens in SecureStore, refreshed before they lapse. Every model
 * call asks for credentials here, so a refresh happens in one place and is saved before use.
 *
 * A refresh the server refuses drops the tokens and keeps LOST, so the app can tell "log in again"
 * from a phone that never logged in.
 */

import * as SecureStore from 'expo-secure-store';
import { needsRefresh, refreshTokens, type AuthFailure, type Fetch, type Tokens } from './auth';
import type { Credentials } from './responses';

// Each token goes under its own key: SecureStore warns above 2 KB a value, and the id and
// access tokens are close to that on their own.
const KEYS = {
  idToken: 'codex.id_token',
  accessToken: 'codex.access_token',
  refreshToken: 'codex.refresh_token',
  meta: 'codex.meta',
} as const;

const LOST = 'codex.lost';

type Meta = Pick<Tokens, 'accountId' | 'email' | 'plan' | 'expiresAt'>;

export type Session =
  | { readonly kind: 'tokens'; readonly tokens: Tokens }
  /** A refresh was refused, so the tokens were dropped. */
  | { readonly kind: 'lost'; readonly email: string | null }
  | { readonly kind: 'none' };

/** Tokens win over LOST: a kill between loseTokens' two steps leaves both, and the next refresh is refused again. */
export async function loadSession(): Promise<Session> {
  const tokens = await loadTokens();
  if (tokens) return { kind: 'tokens', tokens };
  const lost = await SecureStore.getItemAsync(LOST);
  if (lost === null) return { kind: 'none' };
  try {
    const v = JSON.parse(lost) as { email?: unknown };
    return { kind: 'lost', email: typeof v.email === 'string' ? v.email : null };
  } catch {
    return { kind: 'lost', email: null };
  }
}

export async function loadTokens(): Promise<Tokens | null> {
  const [idToken, accessToken, refreshToken, meta] = await Promise.all(Object.values(KEYS).map((k) => SecureStore.getItemAsync(k)));
  if (!idToken || !accessToken || !refreshToken || !meta) return null;
  try {
    const m = JSON.parse(meta) as Meta;
    return { idToken, accessToken, refreshToken, ...m };
  } catch {
    return null;
  }
}

export async function saveTokens(t: Tokens): Promise<void> {
  const meta: Meta = { accountId: t.accountId, email: t.email, plan: t.plan, expiresAt: t.expiresAt };
  await SecureStore.setItemAsync(KEYS.idToken, t.idToken);
  await SecureStore.setItemAsync(KEYS.accessToken, t.accessToken);
  await SecureStore.setItemAsync(KEYS.refreshToken, t.refreshToken);
  await SecureStore.setItemAsync(KEYS.meta, JSON.stringify(meta));
  await SecureStore.deleteItemAsync(LOST);
}

const clearTokens = () => Promise.all(Object.values(KEYS).map((k) => SecureStore.deleteItemAsync(k)));

/** LOST first, so a kill part way still reads as a login that ended. */
async function loseTokens(email: string | null): Promise<void> {
  await SecureStore.setItemAsync(LOST, JSON.stringify({ email }));
  await clearTokens();
}

/** The tokens and LOST: the next screen is the login step. */
export async function logOut(): Promise<void> {
  await clearTokens();
  await SecureStore.deleteItemAsync(LOST);
}

export type CredentialsResult =
  | { readonly ok: true; readonly creds: Credentials; readonly tokens: Tokens }
  | { readonly ok: false; readonly failure: AuthFailure | { readonly kind: 'logged-out' } };

let refreshing: Promise<CredentialsResult> | null = null;

/**
 * Credentials for the next call. Two calls that both find the token stale share one refresh:
 * a refresh token works once, so a second refresh with the old one would log the user out.
 */
export async function credentials(fetchFn: Fetch, opts: { force?: boolean } = {}): Promise<CredentialsResult> {
  const tokens = await loadTokens();
  if (!tokens) return { ok: false, failure: { kind: 'logged-out' } };
  if (!opts.force && !needsRefresh(tokens)) return { ok: true, creds: tokens, tokens };
  refreshing ??= (async (): Promise<CredentialsResult> => {
    try {
      const r = await refreshTokens(fetchFn, tokens);
      if (!r.ok) {
        if (r.failure.kind === 'login-again') await loseTokens(tokens.email);
        return { ok: false, failure: r.failure };
      }
      await saveTokens(r.value);
      return { ok: true, creds: r.value, tokens: r.value };
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}
