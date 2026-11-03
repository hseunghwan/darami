import { CLIENT_ID, completeDeviceLogin, jwtClaims, needsRefresh, refreshTokens, requestDeviceCode, tokensFrom, type DeviceCode, type Fetch, type Tokens } from '../auth';

const b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (claims: object) => `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify(claims))}.sig`;

const ACCOUNT = '11111111-2222-3333-4444-555555555555';
const idToken = jwt({ email: 'squirrel@example.com', name: '다람이', 'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT, chatgpt_plan_type: 'plus' } });
const accessToken = (exp: number) => jwt({ exp });

type Call = { url: string; body: string; contentType: string };

/** A fetch that answers each call from the script in order, and records what it was sent. */
function scripted(answers: { status: number; body: unknown }[]): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const a = answers.shift();
    if (!a) throw new Error(`unexpected call to ${url}`);
    calls.push({ url, body: String(init.body), contentType: (init.headers as Record<string, string>)['content-type'] });
    return { status: a.status, text: async () => (typeof a.body === 'string' ? a.body : JSON.stringify(a.body)) };
  }) as unknown as Fetch;
  return { fetch: fetchFn, calls };
}

describe('jwtClaims', () => {
  it('reads UTF-8 claims from a base64url payload', () => {
    expect(jwtClaims(idToken)?.name).toBe('다람이');
  });

  it('is null for something that is not a JWT', () => {
    expect(jwtClaims('nope')).toBeNull();
    expect(jwtClaims('a.%%%.c')).toBeNull();
  });
});

describe('tokensFrom', () => {
  it('takes the account id, email, and plan from the id token and the expiry from the access token', () => {
    const r = tokensFrom({ id_token: idToken, access_token: accessToken(2_000_000_000), refresh_token: 'rt' });
    expect(r).toEqual({
      ok: true,
      value: { idToken, accessToken: accessToken(2_000_000_000), refreshToken: 'rt', accountId: ACCOUNT, email: 'squirrel@example.com', plan: 'plus', expiresAt: 2_000_000_000_000 },
    });
  });

  it('keeps the previous id and refresh tokens when a refresh leaves them out', () => {
    const first = tokensFrom({ id_token: idToken, access_token: accessToken(1), refresh_token: 'rt' });
    if (!first.ok) throw new Error('setup');
    const r = tokensFrom({ access_token: accessToken(2) }, first.value);
    expect(r.ok && r.value.refreshToken).toBe('rt');
    expect(r.ok && r.value.expiresAt).toBe(2000);
  });

  it('refuses an id token without a ChatGPT account', () => {
    const r = tokensFrom({ id_token: jwt({ email: 'x' }), access_token: accessToken(1), refresh_token: 'rt' });
    expect(r).toEqual({ ok: false, failure: { kind: 'malformed', detail: 'the id token has no ChatGPT account id' } });
  });
});

describe('requestDeviceCode', () => {
  it('sends the Codex client id and reads the answer the endpoint gave on 2026-11-03', async () => {
    const { fetch, calls } = scripted([{ status: 200, body: { device_auth_id: 'dev-1', user_code: 'ABCD-1234', interval: '5', expires_at: '2026-11-03T00:16:23.016214+00:00' } }]);
    const r = await requestDeviceCode(fetch, 0);
    expect(calls[0]).toEqual({ url: 'https://auth.openai.com/api/accounts/deviceauth/usercode', body: JSON.stringify({ client_id: CLIENT_ID }), contentType: 'application/json' });
    expect(r.ok && r.value).toMatchObject({ verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-1234', deviceAuthId: 'dev-1', intervalMs: 5000 });
    expect(r.ok && r.value.expiresAt).toBe(Date.parse('2026-11-03T00:16:23.016Z'));
  });

  it('falls back to fifteen minutes when expires_at is missing', async () => {
    const { fetch } = scripted([{ status: 200, body: { device_auth_id: 'd', usercode: 'C', interval: 5 } }]);
    const r = await requestDeviceCode(fetch, 1000);
    expect(r.ok && r.value.expiresAt).toBe(1000 + 15 * 60_000);
  });

  it('says device login is off when the endpoint answers 404', async () => {
    const { fetch } = scripted([{ status: 404, body: '' }]);
    expect(await requestDeviceCode(fetch)).toEqual({ ok: false, failure: { kind: 'device-login-disabled' } });
  });
});

describe('completeDeviceLogin', () => {
  const code: DeviceCode = { verificationUrl: '', userCode: 'ABCD-1234', deviceAuthId: 'dev-1', intervalMs: 5000, expiresAt: 60_000 };

  it('polls through 403s, then exchanges the code by form post', async () => {
    const { fetch, calls } = scripted([
      { status: 403, body: { error: 'pending' } },
      { status: 404, body: '' },
      { status: 200, body: { authorization_code: 'auth-code', code_challenge: 'ch', code_verifier: 'ver' } },
      { status: 200, body: { id_token: idToken, access_token: accessToken(9), refresh_token: 'rt' } },
    ]);
    const slept: number[] = [];
    const r = await completeDeviceLogin(fetch, code, { sleep: async (ms) => void slept.push(ms), now: () => 0 });
    expect(r.ok && r.value.accountId).toBe(ACCOUNT);
    expect(slept).toEqual([5000, 5000]);
    expect(calls[0]!.body).toBe(JSON.stringify({ device_auth_id: 'dev-1', user_code: 'ABCD-1234' }));
    expect(calls[3]!.url).toBe('https://auth.openai.com/oauth/token');
    expect(calls[3]!.contentType).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(calls[3]!.body))).toEqual({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code: 'auth-code',
      redirect_uri: 'https://auth.openai.com/deviceauth/callback',
      code_verifier: 'ver',
    });
  });

  it('stops when the code expires', async () => {
    const { fetch } = scripted([{ status: 403, body: '' }]);
    expect(await completeDeviceLogin(fetch, code, { sleep: async () => {}, now: () => 60_000 })).toEqual({ ok: false, failure: { kind: 'expired' } });
  });

  it('stops when cancelled', async () => {
    const abort = new AbortController();
    abort.abort();
    const { fetch } = scripted([]);
    expect(await completeDeviceLogin(fetch, code, { signal: abort.signal })).toEqual({ ok: false, failure: { kind: 'cancelled' } });
  });
});

describe('refreshTokens', () => {
  const tokens: Tokens = { idToken, accessToken: accessToken(1), refreshToken: 'old', accountId: ACCOUNT, email: null, plan: null, expiresAt: 1000 };

  it('posts JSON with the refresh token and keeps the old one when none comes back', async () => {
    const { fetch, calls } = scripted([{ status: 200, body: { access_token: accessToken(5000) } }]);
    const r = await refreshTokens(fetch, tokens);
    expect(JSON.parse(calls[0]!.body)).toEqual({ client_id: CLIENT_ID, grant_type: 'refresh_token', refresh_token: 'old' });
    expect(r.ok && r.value).toMatchObject({ refreshToken: 'old', expiresAt: 5_000_000 });
  });

  it.each([
    [400, { error: { code: 'refresh_token_reused' } }, 'refresh_token_reused'],
    [400, { error: 'invalid_grant' }, 'invalid_grant'],
    [401, {}, null],
  ])('asks for a new login on %i %j', async (status, body, code) => {
    const { fetch } = scripted([{ status, body }]);
    expect(await refreshTokens(fetch, tokens)).toEqual({ ok: false, failure: { kind: 'login-again', code } });
  });

  it('treats a server error as passing trouble, not a logout', async () => {
    const { fetch } = scripted([{ status: 502, body: 'bad gateway' }]);
    expect(await refreshTokens(fetch, tokens)).toEqual({ ok: false, failure: { kind: 'http', status: 502, detail: 'bad gateway' } });
  });
});

it('refreshes five minutes before expiry', () => {
  const t = { expiresAt: 10 * 60_000 } as Tokens;
  expect(needsRefresh(t, 4 * 60_000)).toBe(false);
  expect(needsRefresh(t, 6 * 60_000)).toBe(true);
});
