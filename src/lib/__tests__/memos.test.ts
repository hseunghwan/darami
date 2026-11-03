import { finishedText, groupByDay, recentTime, releasedText } from '../memos';
import { withIGa, withRo } from '../../text/ko';

it('groups by local day as 오늘, 어제, then dates', () => {
  const now = new Date('2026-10-29T10:00:00+09:00');
  const groups = groupByDay(
    [
      { captured_at: '2026-10-29T09:00:00+09:00' },
      { captured_at: '2026-10-29T00:30:00+09:00' },
      { captured_at: '2026-10-28T23:59:00+09:00' },
      { captured_at: '2026-10-27T12:00:00+09:00' },
      { captured_at: '2025-12-31T12:00:00+09:00' },
    ],
    now,
    (m) => m.captured_at,
  );
  expect(groups.map((g) => [g.label, g.items.length])).toEqual([['오늘', 2], ['어제', 1], ['10월 27일', 1], ['2025년 12월 31일', 1]]);
});

it('shows 방금, then the clock, then the date', () => {
  const now = new Date('2026-10-29T15:12:30+09:00');
  expect(recentTime(new Date('2026-10-29T15:12:00+09:00'), now)).toBe('방금');
  expect(recentTime(new Date('2026-10-29T14:40:00+09:00'), now)).toBe('오후 2:40');
  expect(recentTime(new Date('2026-10-29T00:05:00+09:00'), now)).toBe('오전 12:05');
  expect(recentTime(new Date('2026-10-28T11:20:00+09:00'), now)).toBe('10월 28일 오전 11:20');
});

it('picks the Korean particle by the final consonant', () => {
  expect(withRo('스터디')).toBe('스터디로');
  expect(withRo('일상')).toBe('일상으로');
  expect(withRo('미루기 아카이빙')).toBe('미루기 아카이빙으로');
  expect(withIGa('미루기 아카이빙')).toBe('미루기 아카이빙이');
  expect(withIGa('스터디')).toBe('스터디가');
});

it('tells a finish by its clock on the day, its date and clock later, and its date alone from the ledger', () => {
  const now = new Date('2026-10-29T15:12:30+09:00');
  expect(finishedText({ at: '2026-10-29T05:02:00.000Z' }, now)).toBe('오후 2:02');
  expect(finishedText({ at: '2026-10-27T05:02:00.000Z' }, now)).toBe('10월 27일 오후 2:02');
  expect(finishedText({ day: '2026-10-28' }, now)).toBe('10월 28일');
});

it('tells a confirm that came too late apart from a move that came too late', () => {
  expect(releasedText({ kind: 'moved-on', started: true }, 'confirm')).toBe('이미 다른 상태가 됐어요.');
  expect(releasedText({ kind: 'moved-on', started: true }, 'move')).toBe('이미 정리가 시작돼서 옮길 수 없어요.');
  expect(releasedText({ kind: 'moved-on', started: false }, 'move')).toBe('지금 상태에서는 옮길 수 없어요.');
  expect(releasedText({ kind: 'gone' }, 'move')).toBe('위키 폴더에 이 메모가 없어요.');
});
