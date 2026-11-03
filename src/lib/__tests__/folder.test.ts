import type { FolderState } from '../../core/wiki';
import type { SafTree } from '../../fs/saf-uri';
import { actionsFor, isUsable, type Candidate } from '../folder';

const tree = { uri: 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2Fwiki', baseId: 'primary:Documents/wiki', name: 'wiki' } as SafTree;
const checked = (state: FolderState): Candidate => ({ kind: 'checked', tree, state });
const wiki = { kind: 'wiki', config: {} as never, warnings: [] } as const;
const broken = { kind: 'broken', problems: [] } as const;

test('each state offers its actions, the primary one first', () => {
  expect(actionsFor(null)).toEqual(['pick']);
  expect(actionsFor(checked({ kind: 'empty' }))).toEqual(['setUp', 'pick']);
  expect(actionsFor(checked({ kind: 'unfinished', locale: 'ko' }))).toEqual(['setUp', 'pick']);
  expect(actionsFor(checked(wiki))).toEqual(['use', 'pick']);
  expect(actionsFor(checked(broken))).toEqual(['recheck', 'use', 'pick']);
  expect(actionsFor(checked({ kind: 'foreign', names: ['notes.md'] }))).toEqual(['pick']);
  expect(actionsFor(checked({ kind: 'unreachable' }))).toEqual(['pick']);
  expect(actionsFor({ kind: 'unsupported', provider: 'com.android.providers.downloads.documents' })).toEqual(['pick']);
});

test('only a wiki, working or broken, can be kept', () => {
  expect(isUsable(wiki)).toBe(true);
  expect(isUsable(broken)).toBe(true);
  for (const s of [{ kind: 'empty' }, { kind: 'unfinished', locale: 'en' }, { kind: 'foreign', names: [] }, { kind: 'unreachable' }] as const) expect(isUsable(s)).toBe(false);
});
