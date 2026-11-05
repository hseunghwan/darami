/**
 * What the domain screens hold and say, apart from React. Pure, so jest covers it; the screens
 * render it and call editDomains.
 */

import { domainIn, type WikiConfig } from '../core/config';
import { draftOf, type DomainDraft, type DraftProblem, type EditRefusal } from '../core/config-edit';
import type { DomainName } from '../core/types';
import type { Edited } from '../state';
import { copy } from '../text';

/** What the domain form opens: a declared domain, whose draft is also what Save compares against, or a blank new one. */
export type Opened =
  | { readonly kind: 'domain'; readonly name: DomainName; readonly draft: DomainDraft }
  | { readonly kind: 'new'; readonly draft: DomainDraft }
  /** A domain the wiki no longer declares, or a wiki that does not read right now. */
  | { readonly kind: 'missing' };

/** `name` is the route's: none opens a new domain. */
export function openDomain(config: WikiConfig | null, name: string | undefined): Opened {
  if (!name) return { kind: 'new', draft: { description: '', pageTypes: [{ type: '', description: '', example: null }] } };
  const declared = config && domainIn(config, name);
  return declared ? { kind: 'domain', name: declared, draft: draftOf(config.domains.get(declared)!) } : { kind: 'missing' };
}

/** A page type as the form holds it. A `kept` row came from the file, so its name is shown, not edited. `example` '' is none. */
export type TypeRow = { readonly key: number; readonly kept: boolean; readonly type: string; readonly description: string; readonly example: string };

export const rowsOf = (opened: Exclude<Opened, { readonly kind: 'missing' }>): TypeRow[] =>
  opened.draft.pageTypes.map((t, key) => ({ key, kept: opened.kind === 'domain', type: t.type, description: t.description, example: t.example ?? '' }));

export const draftFrom = (description: string, rows: readonly TypeRow[]): DomainDraft => ({
  description,
  pageTypes: rows.map((r) => ({ type: r.type, description: r.description, example: r.example === '' ? null : r.example })),
});

const FIELDS: { readonly [F in 'name' | 'description' | 'types']: readonly DraftProblem['kind'][] } = { name: ['name', 'name-taken'], description: ['description'], types: ['no-types'] };

/** The sentences for the problems at one place in the form: the name, the description, the type list, or a type's row. */
export function problemsAt(problems: readonly DraftProblem[], at: keyof typeof FIELDS | number): string[] {
  return problems.filter((p) => (typeof at === 'number' ? 'index' in p && p.index === at : FIELDS[at].includes(p.kind))).map((p) => copy.domains.problem[p.kind]);
}

/** A sentence for every answer but a save, which needs none. */
export function editedText(r: Edited): string | null {
  switch (r.kind) {
    case 'saved':
    case 'same':
      return null;
    case 'refused':
      return refusalText(r.refusal);
    case 'no-wiki':
      return copy.domains.noWiki;
    case 'unreachable':
      return copy.domains.unreachable;
    case 'failed':
      return copy.domains.failed;
  }
}

function refusalText(r: EditRefusal): string {
  const t = copy.domains.refused;
  switch (r.kind) {
    case 'broken':
      return t.broken;
    case 'gone':
      return t.gone(r.domain);
    case 'moved-on':
      return t['moved-on'];
    case 'taken':
      return t.taken[r.by](r.holder);
    case 'layout':
      return t.layout;
    case 'invalid':
      return t.invalid;
  }
}
