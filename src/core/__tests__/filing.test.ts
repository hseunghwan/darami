import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TimeZone } from '../config';
import { appliedPages, classifierText, dayIn, failureOutcome, MAX_ATTEMPTS, parseClassification, withReviewNote } from '../filing';
import type { Change } from '../pages';
import { textFor } from '../text';
import type { DomainName } from '../types';
import { memo } from './helpers';

const 스터디 = '스터디' as DomainName;
const ko = textFor('ko');

test('the applied line lists changed pages first, then new ones, each in byte order, as git status did', () => {
  const at = (path: string, status: Change['status']): Change => ({ path: `스터디/wiki/${path}`, status });
  const changes: Change[] = [
    at('b.md', 'added'), at('z.md', 'modified'), at('𝔸.md', 'added'), at('Ａ.md', 'added'), at('가.md', 'added'), at('m.md', 'deleted'), at('a.md', 'added'),
    at('answers/2026-10-29 Q.md', 'added'), at('index.md', 'modified'), at('log.md', 'modified'), at('_review.md', 'modified'), at('photo.jpg', 'added'),
    { path: '일상/wiki/ME.md', status: 'added' },
  ];
  assert.deepEqual(appliedPages(스터디, changes), ['m.md', 'z.md', 'a.md', 'answers/2026-10-29 Q.md', 'b.md', '가.md', 'Ａ.md', '𝔸.md']);
});

test('the review note is dotoriwiki\'s, under the locale title for a new file and the file\'s own text otherwise', () => {
  const fixture = readFileSync(join(__dirname, 'fixtures', 'made-by-dotoriwiki', '스터디', 'wiki', '_review.md'), 'utf8');
  const reason = 'broken-link 스터디/wiki/a.md: [[없음]] does not resolve';
  const note = { date: '2026-10-29', job: 'ingest' as const, id: '01JB8ZQ4M3T9X7K2W5R6N8P006', locale: 'ko' as const, outcome: { kind: 'gave-up' as const, attempt: 3, max: 3, reason } };
  assert.equal(withReviewNote(null, note, ko), fixture);
  assert.equal(withReviewNote('# 내 메모\n- 손으로 쓴 줄', note, ko), `# 내 메모\n- 손으로 쓴 줄\n- [2026-10-29] ingest \`01JB8ZQ4M3T9X7K2W5R6N8P006\` 포기 3/3: ${reason}\n`);
});

test('an attempt below the max fails or is interrupted, and the max gives up', () => {
  assert.equal(MAX_ATTEMPTS, 3);
  assert.deepEqual(failureOutcome(1, 'r', false), { kind: 'attempt-failed', attempt: 1, max: 3, reason: 'r', interrupted: false });
  assert.deepEqual(failureOutcome(2, 'r', true), { kind: 'attempt-failed', attempt: 2, max: 3, reason: 'r', interrupted: true });
  assert.deepEqual(failureOutcome(3, 'r', true), { kind: 'gave-up', attempt: 3, max: 3, reason: 'r' });
});

test('a classifier answer names a declared domain with a confidence in 0..1, or it is a failed try', () => {
  const domains = ['일상', '스터디'] as DomainName[];
  const answer = (v: unknown) => parseClassification(JSON.stringify(v), domains);
  assert.deepEqual(answer({ domain: '스터디', confidence: 0.6, reason: 'r' }), { kind: 'classified', domain: '스터디', confidence: 0.6, reason: 'r' });
  assert.deepEqual(answer({ domain: '스터디'.normalize('NFD'), confidence: 1, reason: 'r' }).kind, 'classified', 'an NFD name is the declared one');
  assert.deepEqual(answer({ domain: '개발', confidence: 0.9, reason: 'r' }), { kind: 'no-answer', detail: 'classifier named unknown domain 개발' });
  for (const bad of [{ domain: '스터디', confidence: 1.5, reason: 'r' }, { domain: '스터디', confidence: '0.9', reason: 'r' }, { domain: '스터디', confidence: 0.9 }, ['스터디']]) {
    assert.equal(answer(bad).kind, 'no-answer', JSON.stringify(bad));
  }
  assert.equal(parseClassification('스터디', domains).kind, 'no-answer');
});

test('the classifier reads the memo, then an agent memo\'s project, as dotoriwiki sent it', () => {
  assert.equal(classifierText({ ...memo(4, '노트 앱에서 RAG 실험 중', { source: 'agent', context: { project: 'notes-app', cwd: '/w', branch: 'main' } }), attachments: [] }, ko), '노트 앱에서 RAG 실험 중\n\n작성 맥락: 프로젝트 notes-app, 브랜치 main');
  assert.equal(classifierText({ ...memo(1, '그냥 메모'), attachments: [] }, ko), '그냥 메모');
});

test("a day is the wiki's own date, not the phone's or UTC's", () => {
  const at = new Date('2026-10-29T16:30:00Z');
  assert.equal(dayIn('Asia/Seoul' as TimeZone, at), '2026-10-30');
  assert.equal(dayIn('America/Chicago' as TimeZone, at), '2026-10-29');
});
