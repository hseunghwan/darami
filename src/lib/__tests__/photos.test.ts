import { addPhotos, canSend, MAX_PHOTOS, type DraftPhoto } from '../photos';

const photo = (name: string, origin: DraftPhoto['origin'] = 'gallery'): DraftPhoto => ({ uri: `file:///files/outbox/pending/${name}.jpg`, origin, place: null, address: null });

it('sends text, photos, or both, but not nothing', () => {
  expect(canSend('  ', [])).toBe(false);
  expect(canSend('', [photo('a')])).toBe(true);
  expect(canSend('메모', [])).toBe(true);
});

it('caps the strip at ten and reports the rest', () => {
  const nine = Array.from({ length: 9 }, (_, i) => photo(`p${i}`));
  const { photos, dropped } = addPhotos(nine, [photo('x'), photo('y')]);
  expect(photos).toHaveLength(MAX_PHOTOS);
  expect(photos.at(-1)?.uri).toContain('/x.jpg');
  expect(dropped.map((p) => p.uri)).toEqual([photo('y').uri]);
});
