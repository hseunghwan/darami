import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWikiConfig, renderDomainCatalog, renderPageTypes, type ConfigParse } from '../config';
import { textFor } from '../text';

const PRESETS = join(__dirname, '..', '..', '..', 'presets');
const en = readFileSync(join(PRESETS, 'en', 'dotoriwiki.yaml'), 'utf8');
const ko = readFileSync(join(PRESETS, 'ko', 'dotoriwiki.yaml'), 'utf8');
const machine = { modelProfiles: new Set(['default', 'strong']) };
const keys = (r: ConfigParse) => (r.ok ? [] : r.problems.map((p) => p.key));

test('the English preset parses in written order with its page types', () => {
  const r = parseWikiConfig(en, machine);
  assert.ok(r.ok);
  assert.deepEqual(r.warnings, []);
  const c = r.config;
  assert.equal(c.locale, 'en');
  assert.equal(c.timeZone, 'America/Chicago');
  assert.equal(c.fallbackDomain, 'journal');
  assert.deepEqual([...c.domains.keys()], ['journal', 'learning', 'someday']);
  assert.deepEqual(c.domains.get('learning' as never)!.pageTypes.map((t) => t.type), ['concept', 'case', 'project']);
  assert.deepEqual(c.domains.get('journal' as never)!.pageTypes[1], { type: 'person', description: 'One person. What they like, what we did, what they told me', example: 'people/Sam.md' });
});

test('the Korean preset parses, and an NFD domain key is read as NFC', () => {
  for (const text of [ko, ko.replace('미루기 아카이빙:', '미루기 아카이빙:'.normalize('NFD'))]) {
    const r = parseWikiConfig(text, machine);
    assert.ok(r.ok);
    assert.deepEqual([...r.config.domains.keys()], ['일상', '스터디', '미루기 아카이빙']);
    assert.equal(r.config.fallbackDomain, '일상');
    assert.equal(r.config.timeZone, 'Asia/Seoul');
  }
});

test('the domain catalog and page types are headed in the wiki locale', () => {
  for (const [text, catalog, types] of [
    [en, '## Domains\n\n| Folder | What belongs here |\n| --- | --- |\n| `journal` |', '## Page types\n\n| type | Example file | What a page holds |\n| --- | --- | --- |\n| `me` | `Me.md` |'],
    [ko, '## 도메인 목록\n\n| 폴더 | 한 줄 정의 |\n| --- | --- |\n| `일상` |', '## 페이지 종류\n\n| type | 예시 파일 | 내용 |\n| --- | --- | --- |\n'],
  ] as const) {
    const r = parseWikiConfig(text, machine);
    assert.ok(r.ok);
    const t = textFor(r.config.locale);
    assert.ok(renderDomainCatalog(r.config, t).startsWith(catalog), renderDomainCatalog(r.config, t));
    assert.ok(renderPageTypes([...r.config.domains.values()][0]!, t).startsWith(types), renderPageTypes([...r.config.domains.values()][0]!, t));
  }
});

test('an integer-like domain key keeps its written place', () => {
  const r = parseWikiConfig(en.replace('  someday:\n', '  2026:\n'), machine);
  assert.ok(r.ok);
  assert.deepEqual([...r.config.domains.keys()], ['journal', 'learning', '2026']);
});

test('feeds name a declared domain; model_profile resolves against the machine or warns and falls back', () => {
  const text = `${en.replace('    agents_may_read: true\n', '    agents_may_read: true\n    model_profile: strong\n').replace('  someday:\n    description', '  someday:\n    model_profile: huge\n    description')}\nfeeds:\n  hackernews: { domain: learning }\n`;
  const r = parseWikiConfig(text, machine);
  assert.ok(r.ok);
  assert.equal(r.config.domains.get('learning' as never)!.modelProfile, 'strong');
  assert.equal(r.config.domains.get('someday' as never)!.modelProfile, null);
  assert.deepEqual(r.warnings.map((w) => w.key), ['domains.someday.model_profile']);
  assert.match(r.warnings[0]!.problem, /huge is not in this machine's models\.json, so someday runs on edit\.default/);
});

test('each broken variant reports every one of its problems, each with a key and a fix', () => {
  const cases: [string, string, string[]][] = [
    ['misspelled key', en.replace('fallback_domain:', 'fallback_domian:'), ['fallback_domian', 'fallback_domain']],
    ['fallback not a domain', en.replace('fallback_domain: journal', 'fallback_domain: 일상'), ['fallback_domain']],
    ['newer version', en.replace('version: 1', 'version: 2'), ['version']],
    ['missing version, bad locale and zone', en.replace('version: 1\n', '').replace('locale: en', 'locale: fr').replace('America/Chicago', 'Mars/Base'), ['version', 'locale', 'time_zone']],
    ['answer declared, reserved name, bad character', en.replace('      me:\n', '      answer:\n').replace('  someday:\n', '  root:\n').replace('  learning:\n', '  learn#ing:\n'), ['domains.journal.page_types.answer', 'domains.learn#ing', 'domains.root']],
    ['domain without page types or description', `${en.replace('domains:\n', 'domains:\n  recipes: {}\n')}`, ['domains.recipes.description', 'domains.recipes.page_types']],
    ['feed to a missing domain and an unknown feed', `${en}feeds:\n  hackernews: { domain: news }\n  reddit: { domain: learning }\n`, ['feeds.hackernews.domain', 'feeds.reddit']],
    ['bad example path and agents flag', en.replace('example: RAG.md', 'example: ../RAG.md').replace('    agents_may_read: true', '    agents_may_read: yes please'), ['domains.learning.agents_may_read', 'domains.learning.page_types.concept.example']],
    ['no domains', 'version: 1\nlocale: en\ntime_zone: UTC\nfallback_domain: journal\ndomains: {}\n', ['domains', 'fallback_domain']],
    ['YAML syntax', 'version: 1\nlocale: [en\n', ['dotoriwiki.yaml']],
    ['duplicate key', en.replace('locale: en', 'locale: en\nlocale: ko'), ['dotoriwiki.yaml']],
    ['not a mapping', '- a\n- b\n', ['dotoriwiki.yaml']],
  ];
  for (const [name, text, expected] of cases) {
    const r = parseWikiConfig(text, machine);
    assert.deepEqual(keys(r).sort(), [...expected].sort(), name);
    assert.ok(!r.ok && r.problems.every((p) => p.problem && p.fix), `${name}: each problem says what and how to fix`);
  }
});

test('a domain that fails its own checks does not also fail the keys that name it', () => {
  const r = parseWikiConfig(en.replace('    description: My days, the people in them, and what I make of it all\n', ''), machine);
  assert.deepEqual(keys(r), ['domains.journal.description']);
});
