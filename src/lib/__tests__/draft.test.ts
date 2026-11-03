import { draftAfter, parseSavedDraft, savedDraft, type Draft } from '../draft';

const empty: Draft = { id: 'a', text: '', hint: null };

it('keeps the text and id until the accept for that id answers, then starts a new draft with the chip kept', () => {
  const typed = draftAfter(draftAfter(empty, { kind: 'typed', text: '메모' }), { kind: 'hinted', hint: '스터디' });
  expect(draftAfter(typed, { kind: 'filed', id: 'old', next: 'b' })).toBe(typed);
  expect(draftAfter(typed, { kind: 'filed', id: 'a', next: 'b' })).toEqual({ id: 'b', text: '', hint: '스터디' });
});

it('gives back the draft a kill left, unless something was typed first', () => {
  const saved: Draft = { id: 'k', text: '죽기 전에 쓴 것', hint: null };
  expect(draftAfter(empty, { kind: 'restored', saved })).toEqual(saved);
  const typing = draftAfter(empty, { kind: 'typed', text: '새로' });
  expect(draftAfter(typing, { kind: 'restored', saved })).toBe(typing);
  expect(draftAfter(empty, { kind: 'restored', saved: null })).toBe(empty);
});

it('keeps only a draft with text, and reads back only one it wrote', () => {
  expect(savedDraft({ ...empty, text: '  ' })).toBeNull();
  const kept = savedDraft({ id: 'a', text: 'x', hint: '일상' });
  expect(parseSavedDraft(kept)).toEqual({ id: 'a', text: 'x', hint: '일상' });
  for (const bad of [null, '', 'not json', '{"text":"x"}', '{"id":"a","text":3}']) expect(parseSavedDraft(bad)).toBeNull();
});
