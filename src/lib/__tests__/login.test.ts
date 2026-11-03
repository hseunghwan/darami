import type { AuthFailure } from '../../codex/auth';
import type { Tokens } from '../../codex/auth';
import { loginFailureText, loginOf } from '../login';

const tokens: Tokens = { idToken: 'i', accessToken: 'a', refreshToken: 'r', accountId: 'acc', email: 'me@example.com', plan: 'plus', expiresAt: 0 };

it('reads the login from what is stored and whether a model call was refused this launch', () => {
  expect(loginOf({ kind: 'tokens', tokens }, false)).toEqual({ kind: 'in', email: 'me@example.com', plan: 'plus' });
  expect(loginOf({ kind: 'tokens', tokens }, true)).toEqual({ kind: 'expired', email: 'me@example.com' });
  expect(loginOf({ kind: 'lost', email: 'me@example.com' }, false)).toEqual({ kind: 'expired', email: 'me@example.com' });
  expect(loginOf({ kind: 'none' }, true)).toEqual({ kind: 'out' });
});

it('gives each failed login its own sentence, and a cancel none', () => {
  const failures: AuthFailure[] = [
    { kind: 'device-login-disabled' }, { kind: 'expired' }, { kind: 'network', detail: 'x' },
    { kind: 'http', status: 500, detail: 'x' }, { kind: 'malformed', detail: 'x' }, { kind: 'login-again', code: null },
  ];
  const texts = failures.map(loginFailureText);
  expect(texts.every((t) => typeof t === 'string' && t.length > 0)).toBe(true);
  expect(new Set(texts.slice(0, 4)).size).toBe(4);
  expect(texts.slice(3)).toEqual([texts[3], texts[3], texts[3]]);
  expect(loginFailureText({ kind: 'cancelled' })).toBeNull();
});
