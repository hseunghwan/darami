import type { FolderState } from '../../core/wiki';
import type { Login } from '../login';
import { filingStatus, statusLine } from '../status';

const IN: Login = { kind: 'in', email: 'me@example.com', plan: 'plus' };
const WIKI = { kind: 'wiki' } as FolderState;
const base = { login: IN, folder: WIKI, online: true, paused: null, waiting: 2, now: 1_000 };

it('names the first thing that stops filing, in order: login, folder, network, usage limit, the server', () => {
  const kinds = [
    filingStatus({ ...base, login: { kind: 'expired', email: null }, folder: { kind: 'unreachable' }, online: false }),
    filingStatus({ ...base, folder: { kind: 'unreachable' }, online: false }),
    filingStatus({ ...base, online: false, paused: { until: 5_000, cause: 'rate-limited' } }),
    filingStatus({ ...base, paused: { until: 5_000, cause: 'rate-limited' } }),
    filingStatus({ ...base, paused: { until: 5_000, cause: 'server' } }),
    filingStatus(base),
    filingStatus({ ...base, waiting: 0 }),
  ].map((s) => s.kind);
  expect(kinds).toEqual(['login', 'folder', 'offline', 'limited', 'trouble', 'filing', 'idle']);
  expect(filingStatus({ ...base, login: { kind: 'out' } }).kind).toBe('login');
  expect(filingStatus({ ...base, paused: { until: 5_000, cause: 'login' } }).kind).toBe('login');
  expect(filingStatus({ ...base, paused: { until: 5_000, cause: 'network' } }).kind).toBe('offline');
});

it('counts a pause whose time has passed as none, and a folder still being checked as fine', () => {
  expect(filingStatus({ ...base, paused: { until: 1_000, cause: 'rate-limited' } }).kind).toBe('filing');
  expect(filingStatus({ ...base, folder: null }).kind).toBe('filing');
});

it('sends a login problem to the login step, a broken wiki to settings, another folder problem to the folder step', () => {
  expect(statusLine({ kind: 'login', waiting: 3 })).toEqual({ text: '다시 로그인 필요 · 3개 대기', tone: 'warn', href: '/onboarding?repair=login' });
  expect(statusLine({ kind: 'folder', broken: true, waiting: 0 })?.href).toBe('/settings');
  expect(statusLine({ kind: 'folder', broken: false, waiting: 0 })).toEqual({ text: '위키 폴더 확인 필요', tone: 'warn', href: '/onboarding?repair=folder' });
  expect(statusLine({ kind: 'filing', waiting: 2 })).toEqual({ text: '정리 중 2', tone: 'quiet', href: '/activity' });
  expect(statusLine({ kind: 'idle' })).toBeNull();
});
