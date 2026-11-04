import { draftAfter, parseSavedDraft, savedDraft, type Draft } from '../draft';
import type { DraftPhoto } from '../photos';

const empty: Draft = { id: 'a', text: '', hint: null, photos: [] };
const photo = (name: string): DraftPhoto => ({ uri: `file:///files/outbox/pending/${name}.jpg`, origin: 'gallery', place: '사직동', address: null });
const [p1, p2, p3] = [photo('1'), photo('2'), photo('3')];
const withPhotos: Draft = { ...empty, photos: [p1, p2, p3] };

it('keeps the text and id until the accept for that id answers, then starts a new draft with the chip kept', () => {
  const typed = draftAfter(draftAfter(withPhotos, { kind: 'typed', text: '메모' }), { kind: 'hinted', hint: '스터디' });
  expect(draftAfter(typed, { kind: 'filed', id: 'old', next: 'b' })).toBe(typed);
  expect(draftAfter(typed, { kind: 'filed', id: 'a', next: 'b' })).toEqual({ id: 'b', text: '', hint: '스터디', photos: [] });
});

it('photo n always names the same bytes for one id: adding keeps the id, taking one off gives a new one', () => {
  const added = draftAfter(empty, { kind: 'photos-added', photos: [p1, p2] });
  expect(added).toEqual({ ...empty, photos: [p1, p2] });
  expect(draftAfter(added, { kind: 'photos-added', photos: [p3] })).toEqual(withPhotos);
  expect(draftAfter(withPhotos, { kind: 'photo-removed', uri: p2.uri, next: 'b' })).toEqual({ ...empty, id: 'b', photos: [p1, p3] });
  expect(draftAfter(withPhotos, { kind: 'photo-removed', uri: 'file:///else.jpg', next: 'b' })).toBe(withPhotos);
  const full = draftAfter(empty, { kind: 'photos-added', photos: Array.from({ length: 12 }, (_, i) => photo(`f${i}`)) });
  expect(full.photos).toHaveLength(10);
});

it('a refused send takes the photo it names off, or only gives a new id on a conflict', () => {
  expect(draftAfter(withPhotos, { kind: 'refused', refusal: { kind: 'photo-refused', n: 2, reason: 'missing' }, next: 'b' })).toEqual({ ...empty, id: 'b', photos: [p1, p3] });
  expect(draftAfter(withPhotos, { kind: 'refused', refusal: { kind: 'photo-refused', n: 3, reason: 'unsupported' }, next: 'b' })).toEqual({ ...empty, id: 'b', photos: [p1, p2] });
  expect(draftAfter(withPhotos, { kind: 'refused', refusal: { kind: 'photo-refused', n: 1, reason: 'conflict' }, next: 'b' })).toEqual({ ...withPhotos, id: 'b' });
});

it('gives back the draft a kill left, less photos whose files are gone, unless something was typed or picked first', () => {
  const saved: Draft = { id: 'k', text: '죽기 전에 쓴 것', hint: null, photos: [p1, p2] };
  expect(draftAfter(empty, { kind: 'restored', saved, gone: [], next: 'n' })).toEqual(saved);
  expect(draftAfter(empty, { kind: 'restored', saved, gone: [p1.uri], next: 'n' })).toEqual({ ...saved, id: 'n', photos: [p2] });
  const typing = draftAfter(empty, { kind: 'typed', text: '새로' });
  expect(draftAfter(typing, { kind: 'restored', saved, gone: [], next: 'n' })).toBe(typing);
  const picked = draftAfter(empty, { kind: 'photos-added', photos: [p3] });
  expect(draftAfter(picked, { kind: 'restored', saved, gone: [], next: 'n' })).toBe(picked);
  expect(draftAfter(empty, { kind: 'restored', saved: null, gone: [], next: 'n' })).toBe(empty);
});

it('keeps a draft with text or photos, and reads back only what it wrote', () => {
  expect(savedDraft({ ...empty, text: '  ' })).toBeNull();
  expect(parseSavedDraft(savedDraft({ id: 'a', text: 'x', hint: '일상', photos: [] }))).toEqual({ id: 'a', text: 'x', hint: '일상', photos: [] });
  expect(parseSavedDraft(savedDraft(withPhotos))).toEqual(withPhotos);
  for (const bad of [null, '', 'not json', '{"text":"x"}', '{"id":"a","text":3}']) expect(parseSavedDraft(bad)).toBeNull();
  const odd = JSON.stringify({ id: 'a', text: '', photos: [p1, { ...p2, uri: '/etc/passwd' }, { ...p3, origin: 'fax' }, 'x'] });
  expect(parseSavedDraft(odd)?.photos).toEqual([p1]);
});
