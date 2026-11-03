/**
 * The rules of filing a memo that are values, not I/O: the numbers dotoriwiki fixed, the line and
 * the note each outcome writes, the order of the applied line's pages, and what the classifier and
 * the ingest model are told. Pure, like pages.ts; src/jobs/ reads and writes.
 */

import { renderDomainCatalog, renderPageTypes, type DomainConfig, type TimeZone, type WikiConfig } from './config';
import { renderThird, type Failure, type JobKind, type NewOutcome } from './ledger';
import { firstProblem, PAGE_FIELDS, pageMeta, roleOf, type Change, type Memo, type Problem } from './pages';
import { describePhoto } from './photos';
import type { Text } from './text';
import type { DomainName, Locale } from './types';

/** These numbers show in log.md and in hold/, so they are dotoriwiki's. */
export const MAX_ATTEMPTS = 3;
/** A classifier answer below this waits in hold/. Exactly 0.6 routes. */
export const HOLD_BELOW = 0.6;
export const CLASSIFY_TRIES = 2;

/** The reason darami writes on an interrupted attempt. dotoriwiki wrote `gateway stopped mid-job`; the ledger word marks both as interrupted. */
export const INTERRUPTED_REASON = 'app stopped mid-job';

/** A gave-up line has no interrupted word, so its reason is all that says the app stopped. */
const INTERRUPTED_REASONS: ReadonlySet<string> = new Set([INTERRUPTED_REASON, 'gateway stopped mid-job']);

export type FailureCode = Problem['rule'] | 'interrupted' | 'unknown';

/** Why a memo gave up, or why its earlier attempts failed while it waits for the next. dotoriwiki's MemoFailure. */
export type MemoFailure = { readonly attempts: number; readonly max: number; readonly code: FailureCode; readonly detail: string };

export function failureOf(f: Failure, attempts: number): MemoFailure {
  const interrupted = (f.kind === 'attempt-failed' && f.interrupted) || INTERRUPTED_REASONS.has(f.reason);
  const problem = interrupted ? null : firstProblem(f.reason);
  return { attempts, max: f.max, code: interrupted ? 'interrupted' : (problem?.rule ?? 'unknown'), detail: problem?.detail ?? f.reason };
}

/** YYYY-MM-DD in the wiki's zone: the ledger's date, `updated`, the answer page's name. */
export const dayIn = (tz: TimeZone, at: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);

type FailureOutcome = Extract<NewOutcome, { readonly kind: 'attempt-failed' | 'gave-up' }>;

/** `failed k/N` (or `interrupted k/N`) below the max, `gave up N/N` at it. */
export function failureOutcome(attempt: number, reason: string, interrupted: boolean): FailureOutcome {
  return attempt >= MAX_ATTEMPTS
    ? { kind: 'gave-up', attempt, max: MAX_ATTEMPTS, reason }
    : { kind: 'attempt-failed', attempt, max: MAX_ATTEMPTS, reason, interrupted };
}

export type ReviewNote = { readonly date: string; readonly job: JobKind; readonly id: string; readonly locale: Locale; readonly outcome: Extract<Failure, { kind: 'gave-up' }> };

/**
 * _review.md with a give-up note added. A file that exists keeps its own title, because people
 * write in it too; a missing one starts with the locale's title.
 *   - [2026-10-29] ingest `01JB…` 포기 3/3: broken-link 스터디/wiki/a.md: [[없음]] does not resolve
 */
export function withReviewNote(current: string | null, n: ReviewNote, t: Text): string {
  const base = current ?? `${t.reviewTitle}\n\n`;
  return `${base.endsWith('\n') ? base : `${base}\n`}- [${n.date}] ${n.job} \`${n.id}\` ${renderThird(n.locale, n.outcome)}: ${n.outcome.reason}\n`;
}

/** UTF-8 byte order, which is code point order: what git sorts paths by. */
function byCodePoint(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

/**
 * The applied line's fourth field: the pages and answers the job actually changed, as paths under
 * wiki/, in the order dotoriwiki's `git status --porcelain` printed them: changed and deleted files
 * first, then new ones, each group in byte order. index.md, log.md, _review.md, and non-.md files
 * are never listed.
 */
export function appliedPages(domain: DomainName, changes: readonly Change[]): readonly string[] {
  const prefix = `${domain}/wiki/`;
  const listed = changes
    .filter((c) => c.path.startsWith(prefix))
    .map((c) => ({ status: c.status, path: c.path.slice(prefix.length) }))
    .filter((c) => roleOf(c.path) === 'page' || roleOf(c.path) === 'answer');
  const sorted = (cs: typeof listed) => cs.map((c) => c.path).sort(byCodePoint);
  return [...sorted(listed.filter((c) => c.status !== 'added')), ...sorted(listed.filter((c) => c.status === 'added'))];
}

/** A page an ingest commit created or modified, under wiki/ with `.md`, with its type as the job wrote it. */
export type CommittedPage = { readonly pathUnderWiki: string; readonly change: 'created' | 'modified'; readonly type: string | null };

/** appliedPages' list in its order, so a commit's record and its ledger line name the same pages. `contents` is JobTx.changes().contents. */
export function committedPages(domain: DomainName, changes: readonly Change[], contents: ReadonlyMap<string, string>): readonly CommittedPage[] {
  const prefix = `${domain}/wiki/`;
  const added = new Set(changes.filter((c) => c.status === 'added').map((c) => c.path));
  return appliedPages(domain, changes).map((p) => ({
    pathUnderWiki: p,
    change: added.has(prefix + p) ? 'created' : 'modified',
    type: pageMeta(p, contents.get(prefix + p) ?? '').type,
  }));
}

/** The memo, an agent memo's project line, one line per photo: the classifier never sees pixels. */
export const classifierText = (m: Memo, t: Text): string =>
  [m.text, m.context ? t.context(m.context.project, m.context.branch) : '', m.attachments.map((a, i) => describePhoto(a, i, t)).join('\n')]
    .filter(Boolean)
    .join('\n\n');

/** The root CLAUDE.md as written, with no `@` inlining as in dotoriwiki, then the domain catalog. */
export const classifierInstructions = (rootClaude: string, config: WikiConfig, t: Text): string => `${rootClaude}\n\n${renderDomainCatalog(config, t)}`;

/** The enum is the declared domains, so the list is never kept by hand. */
export function classifySchema(domains: readonly DomainName[]): { readonly name: string; readonly schema: Record<string, unknown> } {
  return {
    name: 'route',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['domain', 'confidence', 'reason'],
      properties: { domain: { type: 'string', enum: domains }, confidence: { type: 'number' }, reason: { type: 'string' } },
    },
  };
}

export type Classification =
  | { readonly kind: 'classified'; readonly domain: DomainName; readonly confidence: number; readonly reason: string }
  | { readonly kind: 'no-answer'; readonly detail: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The classifier's final text. No JSON, the wrong shape, a confidence outside 0..1, or an undeclared domain is a failed try. */
export function parseClassification(text: string, domains: readonly DomainName[]): Classification {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { kind: 'no-answer', detail: 'the classifier did not answer JSON' };
  }
  if (!isRecord(v) || typeof v.domain !== 'string' || typeof v.reason !== 'string' || typeof v.confidence !== 'number' || !(v.confidence >= 0 && v.confidence <= 1)) {
    return { kind: 'no-answer', detail: 'the classifier answer has the wrong shape' };
  }
  const named = v.domain.normalize('NFC');
  const domain = domains.find((d) => d === named);
  if (!domain) return { kind: 'no-answer', detail: `classifier named unknown domain ${v.domain}` };
  return { kind: 'classified', domain, confidence: v.confidence, reason: v.reason };
}

/**
 * The ingest model's instructions: dotoriwiki's composition (the domain CLAUDE.md with its `@`
 * imports inlined, the page types, the rules the server sets), then the section on the in-app tools
 * that replaces the CLI's.
 */
export const ingestInstructions = (a: { readonly domainPrompt: string; readonly domain: DomainConfig; readonly date: string; readonly t: Text }): string =>
  [
    a.domainPrompt,
    renderPageTypes(a.domain, a.t),
    a.t.ingest.rules({ date: a.date, fields: PAGE_FIELDS, types: a.domain.pageTypes.map((p) => p.type) }),
    a.t.ingest.workspace(a.domain.name),
  ].join('\n\n');
