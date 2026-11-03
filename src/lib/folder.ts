/**
 * What the folder step offers for each state a picked or kept folder can be in. Pure, so jest
 * covers every state; the folder step renders it and decides nothing else.
 */

import type { FolderState } from '../core/wiki';
import type { SafTree } from '../fs/saf-uri';

/** A folder the picker returned, checked. An unsupported one has no tree: nothing can be read through it. */
export type Candidate =
  | { readonly kind: 'unsupported'; readonly provider: string }
  | { readonly kind: 'checked'; readonly tree: SafTree; readonly state: FolderState };

/** States the user may keep. A broken wiki is still theirs, paused until fixed, as in dotoriwiki. */
export type Usable = Extract<FolderState, { kind: 'wiki' | 'broken' }>;
export const isUsable = (s: FolderState): s is Usable => s.kind === 'wiki' || s.kind === 'broken';

/** setUp writes or finishes the preset, use keeps the folder, recheck inspects it again, pick opens the picker. */
export type FolderAction = 'setUp' | 'use' | 'recheck' | 'pick';

type Actions = readonly [FolderAction, ...FolderAction[]];

const ACTIONS: { readonly [K in FolderState['kind'] | 'unsupported' | 'none']: Actions } = {
  none: ['pick'],
  empty: ['setUp', 'pick'],
  unfinished: ['setUp', 'pick'],
  wiki: ['use', 'pick'],
  broken: ['recheck', 'use', 'pick'],
  foreign: ['pick'],
  unreachable: ['pick'],
  unsupported: ['pick'],
};

/** The primary action first. */
export function actionsFor(c: Candidate | null): Actions {
  return ACTIONS[c === null ? 'none' : c.kind === 'unsupported' ? 'unsupported' : c.state.kind];
}
