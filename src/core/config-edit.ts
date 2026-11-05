/**
 * What the domain editor can change in dotoriwiki.yaml, and how one change lands on the file's
 * text. Pure: wiki.ts reads the folder and writes the result.
 *
 * The unit of change is a whole domain (its description and page types) or the fallback. A screen
 * edits a DomainDraft as a plain value and saves it with the value it opened with, `seen`.
 * applyEdit compares and swaps against the file as it is now:
 *   the file already says `want`   same: nothing to write, so a second Save changes nothing
 *   the file still says `seen`     changed: only the fields that differ are rewritten
 *   anything else                  refused moved-on: another app changed it meanwhile
 * Only the edited domain or the fallback is compared, so edits elsewhere in the file pass.
 *
 * A rename or a delete cannot be said: `domain` keeps its key, and `add` needs a free name. A page
 * type is known by its name, so a type the file lacks is new and one `want` lacks is removed.
 */

import { isAlias, isMap, isNode, isScalar, parseDocument, visit, type Document, type Pair, type YAMLMap } from 'yaml';
import { domainNameProblem, isExamplePath, isLine, pageTypeProblem, parseWikiConfig, type ConfigProblem, type DomainConfig, type MachineFacts, type PageTypeSpec, type WikiConfig } from './config';
import { newDomainSchema } from './presets';
import type { DomainName } from './types';
import { editYamlText } from './yaml-edit';

export type DomainDraft = {
  readonly description: string;
  /** Kept types stay in the file's order and new ones follow in this order. A blank example is none. */
  readonly pageTypes: readonly PageTypeSpec[];
};

export type ConfigEdit =
  /** The declared domain `name` says `want`, if the file still says `seen`. */
  | { readonly kind: 'domain'; readonly name: DomainName; readonly seen: DomainDraft; readonly want: DomainDraft }
  /** `name` is declared saying `want`, after the other domains, with a new `<name>/CLAUDE.md`. */
  | { readonly kind: 'add'; readonly name: string; readonly want: DomainDraft }
  /** fallback_domain names `want`, if the file still names `seen`. */
  | { readonly kind: 'fallback'; readonly seen: DomainName; readonly want: DomainName };

/** A rule a draft breaks, for the form to show under its field. `index` is the page type's row. */
export type DraftProblem =
  | { readonly kind: 'name' | 'name-taken' | 'description' | 'no-types' }
  | { readonly kind: 'type-name' | 'type-answer' | 'type-twice' | 'type-description' | 'type-example'; readonly index: number };

export type EditRefusal =
  /** dotoriwiki.yaml, or a CLAUDE.md it needs, is broken now. */
  | { readonly kind: 'broken'; readonly problems: readonly ConfigProblem[] }
  /** The domain, or the fallback's new target, is no longer declared. */
  | { readonly kind: 'gone'; readonly domain: DomainName }
  /** Another app changed the domain or the fallback since the screen opened. */
  | { readonly kind: 'moved-on' }
  /** A domain, or a folder or file at the root, has the name once case and Unicode form are folded. */
  | { readonly kind: 'taken'; readonly holder: string; readonly by: 'domain' | 'folder' | 'file' }
  /** The change would go through a YAML anchor or alias, so it could change another key as well. */
  | { readonly kind: 'layout' }
  | { readonly kind: 'invalid'; readonly problems: readonly DraftProblem[] };

/** The root entry whose folded name equals a new domain's, as wiki.ts finds it. */
export type RootEntry = { readonly name: string; readonly folder: boolean };

export type Applied =
  | { readonly kind: 'same'; readonly config: WikiConfig }
  | {
      readonly kind: 'changed';
      readonly text: string;
      /** `text` read back. */
      readonly config: WikiConfig;
      /** For `add`: the CLAUDE.md to create before `text` is written. */
      readonly schema: { readonly name: DomainName; readonly text: string } | null;
    }
  | { readonly kind: 'refused'; readonly refusal: EditRefusal };

/** Android's shared storage folds case and Unicode form when it compares names, and so does this. */
export const folded = (name: string): string => name.normalize('NFC').toLowerCase();

/** A new domain's name as it would be written. */
export const addedName = (typed: string): string => typed.normalize('NFC').trim();

/** The editable part of a declared domain: what a screen opens with. */
export const draftOf = (d: DomainConfig): DomainDraft => ({ description: d.description, pageTypes: d.pageTypes });

/**
 * The rules parseWikiConfig holds a domain entry to, checked on a draft as the user types, plus two
 * a YAML map cannot state: two rows with one type, and a new name another domain has once folded.
 * Empty means Save can go.
 */
export function draftProblems(edit: Exclude<ConfigEdit, { readonly kind: 'fallback' }>, config: WikiConfig): readonly DraftProblem[] {
  const want = written(edit.want);
  const out: DraftProblem[] = [];
  if (edit.kind === 'add') {
    const name = addedName(edit.name);
    if (domainNameProblem(name)) out.push({ kind: 'name' });
    else if ([...config.domains.keys()].some((d) => folded(d) === folded(name))) out.push({ kind: 'name-taken' });
  }
  if (!isLine(want.description)) out.push({ kind: 'description' });
  if (want.pageTypes.length === 0) out.push({ kind: 'no-types' });
  want.pageTypes.forEach((t, index) => {
    const bad = pageTypeProblem(t.type);
    if (bad) out.push({ kind: bad === 'word' ? 'type-name' : 'type-answer', index });
    else if (want.pageTypes.findIndex((o) => o.type === t.type) < index) out.push({ kind: 'type-twice', index });
    if (!isLine(t.description)) out.push({ kind: 'type-description', index });
    if (t.example !== null && !isExamplePath(t.example)) out.push({ kind: 'type-example', index });
  });
  return out;
}

/**
 * One edit applied to dotoriwiki.yaml's text as it is now. Never throws for what a user typed or
 * another app wrote. Throws only when its own result would not read back as the edit, which is a
 * bug here and must never reach the file.
 */
export function applyEdit(text: string, edit: ConfigEdit, facts: { readonly machine: MachineFacts; readonly sameNameAtRoot: RootEntry | null }): Applied {
  const parsed = parseWikiConfig(text, facts.machine);
  if (!parsed.ok) return refused({ kind: 'broken', problems: parsed.problems });
  const plan = edit.kind === 'domain' ? editDomain(parsed.config, edit) : edit.kind === 'add' ? addDomain(parsed.config, edit, facts.sameNameAtRoot) : pickFallback(parsed.config, edit);
  if (plan.kind !== 'change') return plan;
  if (plan.shared(parseDocument(text))) return refused({ kind: 'layout' });
  const out = editYamlText(text, plan.mutate);
  const after = parseWikiConfig(out, facts.machine);
  if (!after.ok || JSON.stringify(shapeOf(after.config)) !== JSON.stringify(plan.expect)) throw new Error(`the ${edit.kind} edit does not read back as itself:\n${out}`);
  return { kind: 'changed', text: out, config: after.config, schema: plan.schema };
}

type Change = {
  readonly kind: 'change';
  /** The config the new text must read back as. */
  readonly expect: Shape;
  /** Whether a node the change rewrites can also be reached through an anchor. */
  readonly shared: (doc: Document) => boolean;
  readonly mutate: (doc: Document) => void;
  readonly schema: { readonly name: DomainName; readonly text: string } | null;
};

const refused = (refusal: EditRefusal): Applied => ({ kind: 'refused', refusal });

function editDomain(config: WikiConfig, edit: Extract<ConfigEdit, { readonly kind: 'domain' }>): Applied | Change {
  const now = config.domains.get(edit.name);
  if (!now) return refused({ kind: 'gone', domain: edit.name });
  const current = written(draftOf(now));
  const want = inFileOrder(current, written(edit.want));
  if (sameDraft(current, want)) return { kind: 'same', config };
  if (!sameDraft(current, written(edit.seen))) return refused({ kind: 'moved-on' });
  const problems = draftProblems(edit, config);
  if (problems.length) return refused({ kind: 'invalid', problems });
  const s = shapeOf(config);
  return {
    kind: 'change',
    expect: { ...s, domains: s.domains.map((d) => (d.name === edit.name ? { ...d, draft: want } : d)) },
    shared: (doc) => {
      const shared = sharing(doc);
      const domains = doc.get('domains', true);
      if (shared(domains)) return true;
      const entry = entryOf(asMap(domains), edit.name);
      return shared(entry.key) || shared(entry.value, true);
    },
    mutate: (doc) => patchDomain(doc, asMap(entryOf(asMap(doc.get('domains', true)), edit.name).value), current, want),
    schema: null,
  };
}

function addDomain(config: WikiConfig, edit: Extract<ConfigEdit, { readonly kind: 'add' }>, atRoot: RootEntry | null): Applied | Change {
  const name = addedName(edit.name);
  const want = written(edit.want);
  const holder = [...config.domains.values()].find((d) => folded(d.name) === folded(name));
  if (holder) return holder.name === name && sameDraft(written(draftOf(holder)), want) ? { kind: 'same', config } : refused({ kind: 'taken', holder: holder.name, by: 'domain' });
  // A folder of exactly this name is adopted with what it holds: a domain removed by hand and added back.
  if (atRoot && (atRoot.name !== name || !atRoot.folder)) return refused({ kind: 'taken', holder: atRoot.name, by: atRoot.folder ? 'folder' : 'file' });
  const problems = draftProblems(edit, config);
  if (problems.length) return refused({ kind: 'invalid', problems });
  const domain = name as DomainName;
  const s = shapeOf(config);
  return {
    kind: 'change',
    expect: { ...s, domains: [...s.domains, { name: domain, profile: null, draft: want }] },
    shared: (doc) => sharing(doc)(doc.get('domains', true)),
    mutate: (doc) => asMap(doc.get('domains', true)).add(doc.createPair(domain, new Map<string, unknown>([['description', want.description], ['page_types', new Map(want.pageTypes.map((t) => [t.type, typeFields(t)]))]]))),
    schema: { name: domain, text: newDomainSchema(config.locale, domain, want.description) },
  };
}

function pickFallback(config: WikiConfig, edit: Extract<ConfigEdit, { readonly kind: 'fallback' }>): Applied | Change {
  if (config.fallbackDomain === edit.want) return { kind: 'same', config };
  if (config.fallbackDomain !== edit.seen) return refused({ kind: 'moved-on' });
  if (!config.domains.has(edit.want)) return refused({ kind: 'gone', domain: edit.want });
  return {
    kind: 'change',
    expect: { ...shapeOf(config), fallback: edit.want },
    shared: (doc) => sharing(doc)(doc.get('fallback_domain', true)),
    mutate: (doc) => doc.set('fallback_domain', edit.want),
    schema: null,
  };
}

/**
 * The smallest change from `now` to `want` on a domain's mapping: the description and each type's
 * fields are set only where they differ, removed types go, and new types follow the kept ones.
 * agents_may_read, model_profile, and every comment outside the changed pairs stay.
 */
function patchDomain(doc: Document, node: YAMLMap, now: DomainDraft, want: DomainDraft): void {
  if (now.description !== want.description) node.set('description', want.description);
  const types = asMap(node.get('page_types', true));
  for (const t of now.pageTypes) {
    if (!want.pageTypes.some((w) => w.type === t.type)) types.items.splice(types.items.indexOf(entryOf(types, t.type)), 1);
  }
  for (const w of want.pageTypes) {
    const was = now.pageTypes.find((t) => t.type === w.type);
    if (!was) {
      types.add(doc.createPair(w.type, typeFields(w)));
      continue;
    }
    const fields = asMap(entryOf(types, w.type).value);
    if (was.description !== w.description) fields.set('description', w.description);
    if (was.example !== w.example) {
      if (w.example === null) fields.delete('example');
      else fields.set('example', w.example);
    }
  }
}

const typeFields = (t: PageTypeSpec) => new Map([['description', t.description], ...(t.example === null ? [] : [['example', t.example] as const])]);

/** A draft as it would be written: trimmed, with a blank example as none. */
function written(d: DomainDraft): DomainDraft {
  return {
    description: d.description.trim(),
    pageTypes: d.pageTypes.map((t) => ({ type: t.type.trim(), description: t.description.trim(), example: t.example?.trim() || null })),
  };
}

/** `want` as the file will read once saved: kept types in the file's order, then new ones. */
function inFileOrder(now: DomainDraft, want: DomainDraft): DomainDraft {
  const kept = now.pageTypes.flatMap((t) => want.pageTypes.filter((w) => w.type === t.type));
  return { ...want, pageTypes: [...kept, ...want.pageTypes.filter((w) => !now.pageTypes.some((t) => t.type === w.type))] };
}

const sameDraft = (a: DomainDraft, b: DomainDraft) => JSON.stringify(a) === JSON.stringify(b);

/** What a config says, as an edit is checked against it: every domain as it would be written. */
const shapeOf = (c: WikiConfig) => ({
  locale: c.locale,
  timeZone: c.timeZone as string,
  fallback: c.fallbackDomain as string,
  domains: [...c.domains.values()].map((d) => ({ name: d.name as string, profile: d.modelProfile as string | null, draft: written(draftOf(d)) })),
});
type Shape = ReturnType<typeof shapeOf>;

const keyText = (key: unknown) => String(isScalar(key) ? key.value : key);

/** The pair whose key reads as `name`. Domain keys compare in NFC: a key typed on a Mac is often NFD. */
function entryOf(map: YAMLMap, name: string): Pair {
  const entry = map.items.find((p) => keyText(p.key) === name || keyText(p.key).normalize('NFC') === name);
  if (!entry) throw new Error(`no key ${name}`);
  return entry;
}

function asMap(v: unknown): YAMLMap {
  if (!isMap(v)) throw new Error('expected a mapping');
  return v;
}

/** A test for one node: is it an alias, or does it, or with `deep` anything under it, carry an anchor some alias names. */
function sharing(doc: Document): (node: unknown, deep?: boolean) => boolean {
  const named = new Set<string>();
  visit(doc, { Alias: (_, a) => void named.add(a.source) });
  const hit = (n: unknown) => isAlias(n) || (isNode(n) && n.anchor !== undefined && named.has(n.anchor));
  return (node, deep = false) => {
    if (!deep || !isNode(node)) return hit(node);
    let found = false;
    visit(node, {
      Node: (_, n) => {
        if (!hit(n)) return;
        found = true;
        return visit.BREAK;
      },
    });
    return found;
  };
}
