/**
 * ChatGPT login for Codex, by device code. The user opens the verification page on any device,
 * types the code, and the app polls until the login is approved. Endpoints and fields follow
 * openai/codex codex-rs/login (device_code_auth.rs, oauth/client.rs, auth/manager.rs).
 *
 * No storage here: callers keep the Tokens. fetch and sleep are passed in so tests drive the
 * whole flow without a network.
 */

export const ISSUER = 'https://auth.openai.com';
export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const VERIFICATION_URL = `${ISSUER}/codex/device`;
const DEVICE_API = `${ISSUER}/api/accounts/deviceauth`;
const TOKEN_URL = `${ISSUER}/oauth/token`;
const DEVICE_REDIRECT = `${ISSUER}/deviceauth/callback`;
const CODE_LIFETIME_MS = 15 * 60_000;

export type Fetch = typeof fetch;
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export type Tokens = {
  readonly idToken: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Sent as chatgpt-account-id on every model call. */
  readonly accountId: string;
  readonly email: string | null;
  readonly plan: string | null;
  /** When the access token stops working, from its exp claim. */
  readonly expiresAt: number;
};

export type DeviceCode = {
  readonly verificationUrl: string;
  readonly userCode: string;
  readonly deviceAuthId: string;
  readonly intervalMs: number;
  readonly expiresAt: number;
};

export type AuthFailure =
  /** The account or server has device-code login turned off. */
  | { readonly kind: 'device-login-disabled' }
  | { readonly kind: 'expired' }
  | { readonly kind: 'cancelled' }
  /** The refresh token is spent, revoked, or expired: the user must log in again. */
  | { readonly kind: 'login-again'; readonly code: string | null }
  | { readonly kind: 'http'; readonly status: number; readonly detail: string }
  | { readonly kind: 'network'; readonly detail: string }
  | { readonly kind: 'malformed'; readonly detail: string };

export type AuthResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: AuthFailure };

const ok = <T,>(value: T): AuthResult<T> => ({ ok: true, value });
const fail = <T,>(failure: AuthFailure): AuthResult<T> => ({ ok: false, failure });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

type Posted = { status: number; body: unknown; text: string } | { network: string };

async function post(fetchFn: Fetch, url: string, body: string, contentType: string): Promise<Posted> {
  try {
    const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': contentType }, body });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed, text };
  } catch (e) {
    return { network: e instanceof Error ? e.message : String(e) };
  }
}

/** The payload of a JWT, or null. The signature is not checked: the token came straight from the issuer over TLS. */
export function jwtClaims(jwt: string): Record<string, unknown> | null {
  const part = jwt.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return isRecord(claims) ? claims : null;
  } catch {
    return null;
  }
}

/** Tokens from a token endpoint answer. A refresh may leave out the id or refresh token, so `previous` fills them. */
export function tokensFrom(body: unknown, previous: Tokens | null = null): AuthResult<Tokens> {
  if (!isRecord(body) || typeof body.access_token !== 'string') return fail({ kind: 'malformed', detail: 'no access_token' });
  const idToken = typeof body.id_token === 'string' ? body.id_token : previous?.idToken;
  const refreshToken = typeof body.refresh_token === 'string' ? body.refresh_token : previous?.refreshToken;
  if (!idToken || !refreshToken) return fail({ kind: 'malformed', detail: 'no id_token or refresh_token' });
  const id = jwtClaims(idToken);
  const auth = id && isRecord(id['https://api.openai.com/auth']) ? id['https://api.openai.com/auth'] : null;
  const accountId = auth && typeof auth.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : null;
  if (!accountId) return fail({ kind: 'malformed', detail: 'the id token has no ChatGPT account id' });
  const exp = jwtClaims(body.access_token)?.exp;
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : null;
  const expiresAt = typeof exp === 'number' ? exp * 1000 : Date.now() + (expiresIn ?? 3600) * 1000;
  return ok({
    idToken,
    accessToken: body.access_token,
    refreshToken,
    accountId,
    email: id && typeof id.email === 'string' ? id.email : null,
    plan: auth && typeof auth.chatgpt_plan_type === 'string' ? auth.chatgpt_plan_type : null,
    expiresAt,
  });
}

const httpFailure = (p: { status: number; text: string }): AuthFailure => ({ kind: 'http', status: p.status, detail: p.text.slice(0, 300) });

/** expires_at as epoch seconds, epoch milliseconds, or a date string; null when it is none of those. */
function expiryOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const at = Date.parse(v);
    return Number.isFinite(at) ? at : null;
  }
  return null;
}

export async function requestDeviceCode(fetchFn: Fetch, now = Date.now()): Promise<AuthResult<DeviceCode>> {
  const p = await post(fetchFn, `${DEVICE_API}/usercode`, JSON.stringify({ client_id: CLIENT_ID }), 'application/json');
  if ('network' in p) return fail({ kind: 'network', detail: p.network });
  if (p.status === 404) return fail({ kind: 'device-login-disabled' });
  if (p.status < 200 || p.status >= 300) return fail(httpFailure(p));
  const b = p.body;
  const userCode = isRecord(b) ? (b.user_code ?? b.usercode) : undefined;
  if (!isRecord(b) || typeof b.device_auth_id !== 'string' || typeof userCode !== 'string') {
    return fail({ kind: 'malformed', detail: p.text.slice(0, 200) });
  }
  const interval = Number.parseInt(String(b.interval ?? '5'), 10);
  return ok({
    verificationUrl: VERIFICATION_URL,
    userCode,
    deviceAuthId: b.device_auth_id,
    intervalMs: (Number.isFinite(interval) && interval > 0 ? interval : 5) * 1000,
    expiresAt: expiryOf(b.expires_at) ?? now + CODE_LIFETIME_MS,
  });
}

/** Polls until the user approves the code, then trades it for tokens. */
export async function completeDeviceLogin(
  fetchFn: Fetch,
  code: DeviceCode,
  opts: { signal?: AbortSignal; sleep?: Sleep; now?: () => number } = {},
): Promise<AuthResult<Tokens>> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const body = JSON.stringify({ device_auth_id: code.deviceAuthId, user_code: code.userCode });
  for (;;) {
    if (opts.signal?.aborted) return fail({ kind: 'cancelled' });
    const p = await post(fetchFn, `${DEVICE_API}/token`, body, 'application/json');
    if ('network' in p) return fail({ kind: 'network', detail: p.network });
    if (p.status >= 200 && p.status < 300) {
      const b = p.body;
      if (!isRecord(b) || typeof b.authorization_code !== 'string' || typeof b.code_verifier !== 'string') {
        return fail({ kind: 'malformed', detail: 'no authorization_code in the poll answer' });
      }
      return exchangeCode(fetchFn, b.authorization_code, b.code_verifier);
    }
    // 403 and 404 mean the user has not approved yet.
    if (p.status !== 403 && p.status !== 404) return fail(httpFailure(p));
    if (now() >= code.expiresAt) return fail({ kind: 'expired' });
    await sleep(Math.min(code.intervalMs, Math.max(0, code.expiresAt - now())), opts.signal);
  }
}

async function exchangeCode(fetchFn: Fetch, authorizationCode: string, codeVerifier: string): Promise<AuthResult<Tokens>> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code: authorizationCode,
    redirect_uri: DEVICE_REDIRECT,
    code_verifier: codeVerifier,
  }).toString();
  const p = await post(fetchFn, TOKEN_URL, form, 'application/x-www-form-urlencoded');
  if ('network' in p) return fail({ kind: 'network', detail: p.network });
  if (p.status < 200 || p.status >= 300) return fail(httpFailure(p));
  return tokensFrom(p.body);
}

const LOGIN_AGAIN = new Set(['refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated', 'invalid_grant']);

function errorCode(body: unknown): string | null {
  if (!isRecord(body)) return null;
  if (typeof body.error === 'string') return body.error;
  if (isRecord(body.error) && typeof body.error.code === 'string') return body.error.code;
  return typeof body.code === 'string' ? body.code : null;
}

export async function refreshTokens(fetchFn: Fetch, tokens: Tokens): Promise<AuthResult<Tokens>> {
  const body = JSON.stringify({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: tokens.refreshToken });
  const p = await post(fetchFn, TOKEN_URL, body, 'application/json');
  if ('network' in p) return fail({ kind: 'network', detail: p.network });
  if (p.status >= 200 && p.status < 300) return tokensFrom(p.body, tokens);
  const code = errorCode(p.body);
  if (p.status === 401 || (code !== null && LOGIN_AGAIN.has(code))) return fail({ kind: 'login-again', code });
  return fail(httpFailure(p));
}

/** Refresh a little before expiry, so a long edit does not start with a token about to lapse. */
export const needsRefresh = (t: Tokens, now = Date.now()) => t.expiresAt - now < 5 * 60_000;
