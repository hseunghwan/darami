/**
 * The tabs' gate and onboarding's order. Pure; (tabs)/_layout.tsx and onboarding.tsx decide nothing else.
 */

import type { Login } from './login';

export const STEPS = ['login', 'folder', 'location', 'done'] as const;
export type Step = (typeof STEPS)[number];

/** `?repair=` runs its one step and goes back. Any other value is the whole flow. */
export type Repair = 'login' | 'folder';
export const parseRepair = (s: string | undefined): Repair | null => (s === 'login' || s === 'folder' ? s : null);

/**
 * Where the tabs send a phone that cannot use them yet, or null. An expired login passes: memos
 * still go in and wait, and the badge asks for the login. A kept folder that later reads
 * unreachable stays kept, so the gate never bounces while the folder is being checked at launch.
 */
export function gate(login: Login, folderKept: boolean): string | null {
  if (!folderKept) return '/onboarding';
  return login.kind === 'out' ? '/onboarding?repair=login' : null;
}

/** The repair's step, else the login unless it is already in, else the folder. */
export function firstStep(repair: Repair | null, login: Login): Step {
  return repair ?? (login.kind === 'in' ? 'folder' : 'login');
}

/** After `step`: the repair goes back (null), the flow moves on. */
export const nextStep = (step: Step, repair: Repair | null): Step | null => (repair ? null : (STEPS[STEPS.indexOf(step) + 1] ?? null));
