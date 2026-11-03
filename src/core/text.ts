/**
 * Every sentence the engine writes for a person or a model, by locale. Nothing here is parsed
 * back, so any of it can be reworded in any release. Words that code reads back live next to
 * their parser and never change: the ledger's in ledger.ts, the memo link labels in sources.ts.
 */

import { en } from './text.en';
import { ko } from './text.ko';
import type { Locale } from './types';

export type IngestPromptArgs = {
  readonly id: string;
  readonly hasSource: boolean;
  /** Path, the `![[…]]` name, and the photo's metadata line, per photo. */
  readonly photos: readonly { readonly path: string; readonly file: string; readonly line: string }[];
  /** The latest failure's ledger reason, kept across a retry. */
  readonly lastFailure: string | null;
};

export type Text = {
  /** BCP 47 tag for index.md's sort order. */
  readonly collation: string;
  readonly acceptLanguage: string;

  /** renderDomainCatalog, after the root CLAUDE.md for the classifier and the root chat. */
  readonly catalog: { readonly heading: string; readonly folder: string; readonly definition: string };
  /** renderPageTypes, after a domain's CLAUDE.md for ingest and domain chat. */
  readonly pageTypes: { readonly heading: string; readonly example: string; readonly contents: string };

  /** The classifier's line for an agent memo's working directory. */
  context(project: string, branch: string | null): string;
  /** One photo's when, where, and device for the classifier and the ingest prompt. n counts from 1. */
  photo(n: number, facts: readonly string[]): string;

  readonly ingest: {
    rules(a: { readonly date: string; readonly fields: readonly string[]; readonly types: readonly string[] }): string;
    prompt(a: IngestPromptArgs): string;
  };
  chatRules(target: 'root' | 'domain'): string;

  readonly index: { title(domain: string): string; readonly note: string; readonly other: string; readonly answers: string };
  /** _review.md's first line, written once when the engine creates the file. */
  readonly reviewTitle: string;
  readonly answer: { readonly cited: string; readonly none: string };
  readonly sidecar: {
    truncated(total: number, kept: number): string;
    fetchFailed(detail: string): string;
  };
};

const TEXT: { readonly [L in Locale]: Text } = { ko, en };

export const textFor = (locale: Locale): Text => TEXT[locale];
