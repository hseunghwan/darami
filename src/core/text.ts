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
  /** The `![[…]]` name and the photo's metadata line, per photo, in the order the images follow the prompt. */
  readonly photos: readonly { readonly file: string; readonly line: string }[];
  /** The latest failure's ledger reason, kept across a retry. */
  readonly lastFailure: string | null;
};

export type Text = {
  /** BCP 47 tag for index.md's sort order. */
  readonly collation: string;
  readonly acceptLanguage: string;

  /** renderDomainCatalog, after the root CLAUDE.md for the classifier and the root chat. */
  readonly catalog: {
    readonly heading: string;
    readonly folder: string;
    readonly definition: string;
    /** After the catalog for the classifier, when the root CLAUDE.md's routing rules name none of these domains: ones added in the app. */
    unnamed(domains: readonly string[]): string;
  };
  /** renderPageTypes, after a domain's CLAUDE.md for ingest and domain chat. */
  readonly pageTypes: { readonly heading: string; readonly example: string; readonly contents: string };

  /** The classifier's line for an agent memo's working directory. */
  context(project: string, branch: string | null): string;
  /** One photo's when, where, and device for the classifier and the ingest prompt. n counts from 1. */
  photo(n: number, facts: readonly string[]): string;

  readonly ingest: {
    rules(a: { readonly date: string; readonly fields: readonly string[]; readonly types: readonly string[] }): string;
    prompt(a: IngestPromptArgs): string;
    /** The in-app tools, in place of the section dotoriwiki gave each CLI agent. */
    workspace(domain: string): string;
    /** Sent when a turn ends with no tool call. */
    readonly nudge: string;
  };
  /** A chat's sections after the root or domain prompt. `domain` is null for a root chat. */
  readonly chat: {
    rules(domain: string | null): string;
    /** The in-app tools: paths start at the wiki folder, and nothing can be written. */
    workspace(domain: string | null): string;
    /** The one turn after the limits, sent with no tools. */
    readonly wrapUp: string;
  };

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
