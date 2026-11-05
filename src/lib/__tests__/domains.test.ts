import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyEdit, draftProblems, type ConfigEdit } from '../../core/config-edit';
import { parseWikiConfig } from '../../core/config';
import type { DomainName } from '../../core/types';
import { draftFrom, editedText, openDomain, problemsAt, rowsOf, type TypeRow } from '../domains';

const KO = readFileSync(join(__dirname, '..', '..', '..', 'presets', 'ko', 'dotoriwiki.yaml'), 'utf8');
const machine = { modelProfiles: new Set<string>() };
const parsed = parseWikiConfig(KO, machine);
if (!parsed.ok) throw new Error('the preset parses');
const config = parsed.config;

/** The edit the form would save after `change` touches its rows, as the screen builds it. */
function formEdit(change: (rows: TypeRow[]) => TypeRow[] = (r) => r): ConfigEdit {
  const opened = openDomain(config, '스터디');
  if (opened.kind !== 'domain') throw new Error('스터디 opens');
  return { kind: 'domain', name: opened.name, seen: opened.draft, want: draftFrom(opened.draft.description, change(rowsOf(opened))) };
}

it('opens a declared domain by its name in either Unicode form, a blank one for no name, and nothing for a stale link', () => {
  expect(openDomain(config, '스터디'.normalize('NFD'))).toMatchObject({ kind: 'domain', name: '스터디', draft: { description: '일에서든 혼자서든 내가 직접 해보고 배운 것' } });
  expect(openDomain(config, undefined)).toEqual({ kind: 'new', draft: { description: '', pageTypes: [{ type: '', description: '', example: null }] } });
  expect(openDomain(config, '요리')).toEqual({ kind: 'missing' });
  expect(openDomain(null, '스터디')).toEqual({ kind: 'missing' });
});

it('a form saved as it opened writes nothing, and clearing an example removes it from the file', () => {
  expect(applyEdit(KO, formEdit(), { machine, sameNameAtRoot: null }).kind).toBe('same');
  const cleared = applyEdit(KO, formEdit((rows) => rows.map((r) => (r.type === 'case' ? { ...r, example: '' } : r))), { machine, sameNameAtRoot: null });
  expect(cleared.kind === 'changed' && cleared.text).toBe(KO.replace('        example: 케이스/회의 안건을 질문으로 쓰기.md\n', ''));
});

it('puts each problem under its field or its row', () => {
  const edit: ConfigEdit = { kind: 'add', name: '스터디', want: { description: '', pageTypes: [{ type: 'ok', description: 'fine', example: null }, { type: 'answer', description: '', example: 'x.txt' }] } };
  const problems = draftProblems(edit, config);
  expect(problemsAt(problems, 'name')).toEqual(['같은 이름의 도메인이 있어요. 대소문자만 달라도 같은 이름이에요.']);
  expect(problemsAt(problems, 'description')).toEqual(['한 줄로 적어 주세요.']);
  expect(problemsAt(problems, 0)).toEqual([]);
  expect(problemsAt(problems, 1)).toHaveLength(3);
  expect(problemsAt(problems, 'types')).toEqual([]);
});

it('words every answer but a save, naming the domain or the name in the way', () => {
  const saved = { kind: 'saved', config } as const;
  expect(editedText(saved)).toBeNull();
  expect(editedText({ kind: 'same', config })).toBeNull();
  expect(editedText({ kind: 'refused', refusal: { kind: 'gone', domain: '요리' as DomainName } })).toContain('요리');
  expect(editedText({ kind: 'refused', refusal: { kind: 'taken', holder: 'Recipes', by: 'folder' } })).toContain('Recipes');
  const others = [
    editedText({ kind: 'refused', refusal: { kind: 'broken', problems: [] } }),
    editedText({ kind: 'refused', refusal: { kind: 'moved-on' } }),
    editedText({ kind: 'refused', refusal: { kind: 'layout' } }),
    editedText({ kind: 'refused', refusal: { kind: 'invalid', problems: [] } }),
    editedText({ kind: 'refused', refusal: { kind: 'taken', holder: 'x', by: 'domain' } }),
    editedText({ kind: 'refused', refusal: { kind: 'taken', holder: 'x', by: 'file' } }),
    editedText({ kind: 'no-wiki' }),
    editedText({ kind: 'unreachable' }),
    editedText({ kind: 'failed', message: 'EIO' }),
  ];
  expect(new Set(others).size).toBe(others.length);
  for (const text of others) expect(text).toMatch(/\S/);
});
