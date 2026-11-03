import type { Login } from '../login';
import { firstStep, gate, nextStep, parseRepair } from '../onboarding';

const IN: Login = { kind: 'in', email: null, plan: null };
const EXPIRED: Login = { kind: 'expired', email: null };
const OUT: Login = { kind: 'out' };

it('opens the tabs once a folder is kept and the phone has logged in, even when that login has since expired', () => {
  expect(gate(OUT, false)).toBe('/onboarding');
  expect(gate(IN, false)).toBe('/onboarding');
  expect(gate(OUT, true)).toBe('/onboarding?repair=login');
  expect(gate(EXPIRED, true)).toBeNull();
  expect(gate(IN, true)).toBeNull();
});

it('starts a fresh install at the login, a phone killed after its login at the folder, and a repair at its own step', () => {
  expect(firstStep(null, OUT)).toBe('login');
  expect(firstStep(null, EXPIRED)).toBe('login');
  expect(firstStep(null, IN)).toBe('folder');
  expect(firstStep('login', IN)).toBe('login');
  expect(firstStep('folder', OUT)).toBe('folder');
});

it('walks login, folder, location, done, and a repair runs one step', () => {
  expect([nextStep('login', null), nextStep('folder', null), nextStep('location', null), nextStep('done', null)]).toEqual(['folder', 'location', 'done', null]);
  expect(nextStep('login', 'login')).toBeNull();
  expect([parseRepair('login'), parseRepair('folder'), parseRepair('401'), parseRepair(undefined)]).toEqual(['login', 'folder', null, null]);
});
