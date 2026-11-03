/**
 * Every sentence the app shows, by locale, picked once at startup from the phone's language.
 * ko is the shape: en must match it key for key, so a missing or extra key fails tsc, and
 * text.test.ts fails on any Hangul in en. Words from the wiki folder (domain names, a verdict the
 * engine never wrote, failure details) are shown as they come.
 */

import type { FailureCode as Code } from '../core/filing';
import type { VerdictId } from '../core/ledger';
import type { MemoState } from '../core/places';
import { deviceTag } from './device';
import { en } from './en';
import { ko } from './ko';

export type { MemoState, VerdictId };
export type Locale = 'ko' | 'en';
export type Copy = typeof ko;
/** The failure codes the app words. broken-link has a sentence of its own, and unknown gets failure.unknown. */
export type FailureCode = Exclude<Code, 'broken-link' | 'unknown'>;

export const COPY: { readonly [L in Locale]: Copy } = { ko, en };

/** Korean for any ko tag, English for everything else. */
export const localeFor = (tag: string | undefined): Locale => (/^ko(?:[-_]|$)/i.test(tag ?? '') ? 'ko' : 'en');

export const locale: Locale = localeFor(deviceTag());
export const copy: Copy = COPY[locale];
