import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyEdit, draftOf, draftProblems, type Applied, type ConfigEdit, type DomainDraft, type RootEntry } from '../config-edit';
import { parseWikiConfig } from '../config';
import type { DomainName } from '../types';

const PRESETS = join(__dirname, '..', '..', '..', 'presets');
const HAND = readFileSync(join(__dirname, 'fixtures', 'hand-edited.yaml'), 'utf8');
const EN = readFileSync(join(PRESETS, 'en', 'dotoriwiki.yaml'), 'utf8');
const KO = readFileSync(join(PRESETS, 'ko', 'dotoriwiki.yaml'), 'utf8');
const machine = { modelProfiles: new Set(['deep']) };
const d = (name: string) => name as DomainName;

const configOf = (text: string) => {
  const r = parseWikiConfig(text, machine);
  assert.ok(r.ok, 'the fixture parses');
  return r.config;
};
const seenIn = (text: string, name: string): DomainDraft => draftOf(configOf(text).domains.get(d(name))!);
const apply = (text: string, edit: ConfigEdit, sameNameAtRoot: RootEntry | null = null): Applied => applyEdit(text, edit, { machine, sameNameAtRoot });
const changedText = (r: Applied): string => {
  assert.equal(r.kind, 'changed', JSON.stringify(r));
  return r.kind === 'changed' ? r.text : '';
};
const refusal = (r: Applied) => (r.kind === 'refused' ? r.refusal : r.kind);

/** `text` with `from` swapped for `to`, which must be in it once: the whole expected file. */
const swapped = (text: string, from: string, to: string) => {
  assert.equal(text.split(from).length, 2, `the fixture holds ${JSON.stringify(from)} once`);
  return text.replace(from, to);
};

test('a description edit on a hand-formatted file rewrites that one line, and saving it again changes nothing', () => {
  for (const [name, text] of [['as written', HAND], ['BOM and CRLF', `\uFEFF${HAND.replaceAll('\n', '\r\n')}`]] as const) {
    const seen = seenIn(text, 'learning');
    const edit: ConfigEdit = { kind: 'domain', name: d('learning'), seen, want: { ...seen, description: 'Things I tried' } };
    const out = changedText(apply(text, edit));
    assert.equal(out, swapped(text, '        description: What I learned by doing it myself', '        description: Things I tried'), name);
    assert.equal(apply(out, edit).kind, 'same', `${name}: a second Save`);
  }
});

test('one save changes a type, removes another, and adds a third, touching only their lines', () => {
  const seen = seenIn(HAND, 'learning');
  const want: DomainDraft = {
    ...seen,
    pageTypes: [
      ...seen.pageTypes.filter((t) => t.type !== '2026').map((t) => (t.type === 'case' ? { ...t, description: 'A situation, retold' } : t)),
      { type: 'talk', description: 'A talk I went to', example: 'talks/x.md' },
    ],
  };
  const out = changedText(apply(HAND, { kind: 'domain', name: d('learning'), seen, want }));
  assert.equal(
    out,
    swapped(
      HAND,
      '                description: A situation\n            2026:\n                description: An integer-like key that must stay in place\n',
      '                description: A situation, retold\n            talk:\n                description: A talk I went to\n                example: talks/x.md\n',
    ),
  );
});

test('an example is set, changed, or removed on its own line, and a blank example means none', () => {
  const seen = seenIn(EN, 'journal');
  const examples: Record<string, string | null> = { me: '', person: 'people/Kim.md', theme: 'themes/Work and rest.md' };
  const want = { ...seen, pageTypes: seen.pageTypes.map((t) => ({ ...t, example: examples[t.type]! })) };
  const out = changedText(apply(EN, { kind: 'domain', name: d('journal'), seen, want }));
  assert.equal(out, swapped(swapped(EN, '        example: Me.md\n', ''), '        example: people/Sam.md', '        example: people/Kim.md'));
});

test('a domain key typed on a Mac in NFD is found, and its key keeps its bytes', () => {
  const text = KO.replace('  스터디:', `  ${'스터디'.normalize('NFD')}:`);
  const seen = seenIn(text, '스터디');
  const out = changedText(apply(text, { kind: 'domain', name: d('스터디'), seen, want: { ...seen, description: '직접 해본 것' } }));
  assert.equal(out, swapped(text, '    description: 일에서든 혼자서든 내가 직접 해보고 배운 것', '    description: 직접 해본 것'));
});

test('a new domain goes after the others with its CLAUDE.md in the wiki language, quoted where YAML needs it', () => {
  const want: DomainDraft = { description: 'Dishes: what worked', pageTypes: [{ type: 'recipe', description: 'One dish', example: 'Kimchi stew.md' }] };
  const r = apply(EN, { kind: 'add', name: ' recipes ', want });
  assert.equal(
    changedText(r),
    swapped(EN, '        example: ideas/Budget app.md\n', '        example: ideas/Budget app.md\n  recipes:\n    description: "Dishes: what worked"\n    page_types:\n      recipe:\n        description: One dish\n        example: Kimchi stew.md\n'),
  );
  assert.ok(r.kind === 'changed');
  assert.deepEqual(r.schema, { name: 'recipes', text: '# recipes\n\n@../_schema/common-rules.md\n\n## Purpose\n\nDishes: what worked\n' });
  assert.deepEqual([...r.config.domains.keys()], ['journal', 'learning', 'someday', 'recipes']);

  const ko = apply(KO, { kind: 'add', name: '요리', want: { description: '해 본 요리', pageTypes: [{ type: 'recipe', description: '요리 하나', example: null }] } });
  assert.ok(ko.kind === 'changed');
  assert.deepEqual(ko.schema, { name: '요리', text: '# 요리\n\n@../_schema/공통규칙.md\n\n## 목적\n\n해 본 요리\n' });
});

test('the fallback changes in place with its quoting, and only while the file still names what the screen saw', () => {
  const edit: ConfigEdit = { kind: 'fallback', seen: d('journal'), want: d('learning') };
  const out = changedText(apply(HAND, edit));
  assert.equal(out, swapped(HAND, "fallback_domain: 'journal'", "fallback_domain: 'learning'"));
  assert.equal(apply(out, edit).kind, 'same', 'a second Save');
  assert.deepEqual(refusal(apply(swapped(HAND, "'journal'", 'someday'), edit)), { kind: 'moved-on' });
  assert.deepEqual(refusal(apply(HAND, { kind: 'fallback', seen: d('journal'), want: d('recipes') })), { kind: 'gone', domain: 'recipes' });
});

test('a domain edit refuses when another app changed that domain, and passes when it changed anything else', () => {
  const seen = seenIn(HAND, 'learning');
  const edit: ConfigEdit = { kind: 'domain', name: d('learning'), seen, want: { ...seen, description: 'Things I tried' } };
  const theirs = swapped(HAND, '                description: One idea\n', '                description: One idea, edited in Obsidian\n');
  assert.deepEqual(refusal(apply(theirs, edit)), { kind: 'moved-on' });
  const same = swapped(HAND, 'What I learned by doing it myself', 'Things I tried');
  assert.equal(apply(same, edit).kind, 'same', 'another app made the same change');
  const elsewhere = swapped(swapped(HAND, '# top comment', '# top comment, reworded'), 'A recurring thought', 'A thought that keeps coming back');
  assert.equal(changedText(apply(elsewhere, edit)), swapped(elsewhere, 'What I learned by doing it myself', 'Things I tried'));
  const someday = seenIn(HAND, 'someday');
  const renamed = swapped(HAND, '    someday:\n', '    later:\n');
  assert.deepEqual(refusal(apply(renamed, { kind: 'domain', name: d('someday'), seen: someday, want: { ...someday, description: 'Later' } })), { kind: 'gone', domain: 'someday' });
});

test('a broken file refuses every edit with its problems and is not rewritten', () => {
  const r = apply(swapped(HAND, 'version: 1', 'version: 2'), { kind: 'fallback', seen: d('journal'), want: d('learning') });
  assert.equal(r.kind, 'refused');
  assert.ok(r.kind === 'refused' && r.refusal.kind === 'broken');
  assert.deepEqual(r.refusal.problems.map((p) => p.key), ['version']);
});

test('a new name another domain, folder, or file has once case and Unicode form are folded is taken; a folder of exactly that name is adopted', () => {
  const want: DomainDraft = { description: 'Dishes', pageTypes: [{ type: 'recipe', description: 'One dish', example: null }] };
  const add = (name: string, atRoot: RootEntry | null = null) => apply(EN, { kind: 'add', name, want }, atRoot);
  assert.deepEqual(refusal(add('Learning')), { kind: 'taken', holder: 'learning', by: 'domain' });
  assert.deepEqual(refusal(add('learning')), { kind: 'taken', holder: 'learning', by: 'domain' });
  assert.deepEqual(draftProblems({ kind: 'add', name: 'LEARNING', want }, configOf(EN)), [{ kind: 'name-taken' }], 'the form marks it before Save');
  assert.equal(apply(EN, { kind: 'add', name: 'learning', want: seenIn(EN, 'learning') }).kind, 'same', 'an add saved before');
  assert.deepEqual(refusal(add('recipes', { name: 'Recipes', folder: true })), { kind: 'taken', holder: 'Recipes', by: 'folder' });
  assert.deepEqual(refusal(add('recipes', { name: 'recipes', folder: false })), { kind: 'taken', holder: 'recipes', by: 'file' });
  assert.equal(add('recipes', { name: 'recipes', folder: true }).kind, 'changed');
});

test('a change that would go through a YAML anchor is refused; one beside it goes through', () => {
  const text = 'version: 1\nlocale: en\ntime_zone: UTC\nfallback_domain: a\ndomains:\n  a:\n    description: A\n    page_types: &types\n      x:\n        description: shared\n  b:\n    description: B\n    page_types: *types\n';
  for (const name of ['a', 'b']) {
    const seen = seenIn(text, name);
    assert.deepEqual(refusal(apply(text, { kind: 'domain', name: d(name), seen, want: { ...seen, description: 'changed' } })), { kind: 'layout' }, name);
  }
  assert.equal(apply(text, { kind: 'add', name: 'c', want: seenIn(text, 'a') }).kind, 'changed');
  assert.equal(apply(text, { kind: 'fallback', seen: d('a'), want: d('b') }).kind, 'changed');
});

test('the form and the save hold a draft to the same rules, each problem at its field and row', () => {
  const config = configOf(EN);
  const seen = seenIn(EN, 'learning');
  const row = (type: string, description = 'A page', example: string | null = null) => ({ type, description, example });
  const cases: [string, ConfigEdit & { kind: 'domain' | 'add' }, object[]][] = [
    ['blank description', { kind: 'domain', name: d('learning'), seen, want: { ...seen, description: '  ' } }, [{ kind: 'description' }]],
    ['no page types', { kind: 'domain', name: d('learning'), seen, want: { ...seen, pageTypes: [] } }, [{ kind: 'no-types' }]],
    [
      'bad rows',
      { kind: 'domain', name: d('learning'), seen, want: { ...seen, pageTypes: [row('two words'), row('answer'), row('concept'), row('concept'), row('x', ' '), row('y', 'Y', '/abs.md'), row('z', 'Z', ' ')] } },
      [{ kind: 'type-name', index: 0 }, { kind: 'type-answer', index: 1 }, { kind: 'type-twice', index: 3 }, { kind: 'type-description', index: 4 }, { kind: 'type-example', index: 5 }],
    ],
    ['reserved name', { kind: 'add', name: 'inbox', want: seen }, [{ kind: 'name' }]],
    ['underscore name', { kind: 'add', name: '_mine', want: seen }, [{ kind: 'name' }]],
    ['bad character', { kind: 'add', name: 'a/b', want: seen }, [{ kind: 'name' }]],
  ];
  for (const [name, edit, problems] of cases) {
    assert.deepEqual(draftProblems(edit, config), problems, name);
    assert.deepEqual(refusal(apply(EN, edit)), { kind: 'invalid', problems }, `${name}: Save refuses what the form marks`);
  }
  const fine: ConfigEdit = { kind: 'add', name: 'recipes', want: { description: 'Dishes', pageTypes: [row('recipe', 'One dish', 'Kimchi stew.md')] } };
  assert.deepEqual(draftProblems(fine, config), []);
  assert.equal(apply(EN, fine).kind, 'changed');
});
