import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMap, isScalar, parseDocument, type Document, type YAMLMap } from 'yaml';
import { editYamlText } from '../yaml-edit';

const HAND = readFileSync(join(__dirname, 'fixtures', 'hand-edited.yaml'), 'utf8');
const PRESETS = join(__dirname, '..', '..', '..', 'presets');

const map = (v: unknown): YAMLMap => {
  assert.ok(isMap(v), 'a mapping');
  return v;
};
const entry = (m: YAMLMap, key: string) => m.items.find((p) => String(isScalar(p.key) ? p.key.value : p.key) === key)!;
const domain = (doc: Document, name: string) => map(entry(map(doc.get('domains', true)), name).value);
const types = (doc: Document, name: string) => map(domain(doc, name).get('page_types', true));
const setDescription = (name: string, to: string) => (doc: Document) => domain(doc, name).set('description', to);

/** `text` with its line `line` replaced by `by`: an expected file is the input plus the change and nothing else. */
const replaced = (text: string, line: string, by: string) => {
  assert.ok(text.includes(`${line}\n`), `the fixture holds ${line}`);
  return text.replace(`${line}\n`, `${by}\n`);
};

test('a changed value rewrites only its own line, keeping the indent, comments, and quoting around it', () => {
  const out = editYamlText(HAND, setDescription('learning', 'Things I tried'));
  assert.equal(out, replaced(HAND, '        description: What I learned by doing it myself', '        description: Things I tried'));
});

test('a BOM and CRLF line ends are kept, and only the changed line differs', () => {
  for (const [name, text] of [['crlf', HAND.replaceAll('\n', '\r\n')], ['bom', `\uFEFF${HAND}`], ['bom and crlf', `\uFEFF${HAND.replaceAll('\n', '\r\n')}`]] as const) {
    const out = editYamlText(text, setDescription('learning', 'Things I tried'));
    assert.equal(out, text.replace('        description: What I learned by doing it myself', '        description: Things I tried'), name);
  }
});

test('a pair added to a block map adds only its own lines, at the end of that map and at the file indent', () => {
  const out = editYamlText(HAND, (doc) => void types(doc, 'learning').add(doc.createPair('talk', doc.createNode(new Map([['description', 'A talk I went to']])))));
  const last = '                description: An integer-like key that must stay in place';
  assert.equal(out, replaced(HAND, last, `${last}\n            talk:\n                description: A talk I went to`));
});

test('a pair added to the domains map lands before the comment that closes it', () => {
  const out = editYamlText(HAND, (doc) => {
    const node = doc.createNode(new Map<string, unknown>([['description', 'Dishes I cook'], ['page_types', new Map([['recipe', new Map([['description', 'One dish']])]])]]));
    map(doc.get('domains', true)).add(doc.createPair('recipes', node));
  });
  const closing = '    # comment after the last domain, inside domains';
  assert.equal(out, replaced(HAND, closing, `    recipes:\n        description: Dishes I cook\n        page_types:\n            recipe:\n                description: One dish\n${closing}`));
});

test('a removed pair takes its lines and the comment written above it, and nothing else', () => {
  const out = editYamlText(HAND, (doc) => void types(doc, 'learning').delete('case'));
  assert.equal(out, HAND.replace('            # a comment above case\n            case:\n                description: A situation\n', ''));
});

test('a flow map changes only on its own line', () => {
  const out = editYamlText(HAND, (doc) => void types(doc, 'journal').add(doc.createPair('person', doc.createNode(new Map([['description', 'One person']])))));
  assert.equal(
    out,
    replaced(
      HAND,
      '        page_types: { me: { description: How I tend to act, example: Me.md }, theme: {description: A recurring thought} }',
      '        page_types: { me: { description: How I tend to act, example: Me.md }, theme: { description: A recurring thought }, person: { description: One person } }',
    ),
  );
});

test('where the change and the file\'s own spacing meet on one line, that line takes yaml\'s spacing and the rest stays', () => {
  const out = editYamlText(HAND, (doc) => doc.set('locale', 'ko'));
  assert.equal(out, replaced(HAND, 'locale: en   # inline comment on locale', 'locale: ko # inline comment on locale'));
});

test('a preset file changes by exactly the edited line', () => {
  for (const [l, name, line] of [['en', 'someday', '    description: Things to watch, read, or try later, and ideas not yet started'], ['ko', '미루기 아카이빙', '    description: 나중에 보거나 읽거나 해볼 것, 아직 시작하지 않은 아이디어']] as const) {
    const text = readFileSync(join(PRESETS, l, 'dotoriwiki.yaml'), 'utf8');
    assert.equal(editYamlText(text, setDescription(name, '바뀜')), replaced(text, line, '    description: 바뀜'), l);
  }
});

test('when the merged lines would not read back as the change, the whole file comes back as yaml writes it, with the change and every comment', () => {
  // The two `# note` lines pair up wrongly in the line diff, and a merge would declare description twice.
  const text = 'domains:\n  a:\n  # note\n    description: old\n    page_types:   # tail\n    # note\n';
  const out = editYamlText(text, setDescription('a', 'new'));
  const doc = parseDocument(out);
  assert.deepEqual(doc.errors, [], out);
  assert.deepEqual(doc.toJS(), { domains: { a: { description: 'new', page_types: null } } });
  assert.deepEqual(out.match(/# \w+/g), ['# note', '# tail', '# note'], 'every comment is kept');
});
