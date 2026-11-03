import type { DomainName } from '../../core/types';
import type { MemoFailure } from '../../jobs/engine';
import { attemptsNote, failureSentence } from '../failure';

describe('failureSentence', () => {
  it.each([
    ['llm', '정리하다가 멈췄어요. 시간이 너무 오래 걸렸거나 실행이 실패했어요.'],
    ['scope', '위키 폴더 밖에 쓰려고 해서 막았어요.'],
    ['input-modified', '정리하는 사이에 원본 메모가 바뀌었어요.'],
    ['append-only', '확인 목록에 이미 있던 줄을 고치려고 해서 막았어요.'],
    ['frontmatter', '페이지 정보에 꼭 필요한 항목이 빠졌어요.'],
    ['type', '이 도메인에 없는 종류의 페이지를 만들려고 했어요.'],
    ['empty', '내용이 빈 페이지를 만들었어요.'],
    ['interrupted', '앱이 닫혀서 정리가 중간에 멈췄어요. 다시 시도해요.'],
    ['unknown', '정리하지 못했어요.'],
    ['something-new', '정리하지 못했어요.'],
  ])('%s', (code, text) => {
    expect(failureSentence({ code: code as MemoFailure['code'], detail: 'x' })).toEqual({ text, link: null });
  });

  it('names the missing page from the first [[...]] of a broken-link detail', () => {
    const detail = '스터디/wiki/케이스/postgres.md: [[쿼리 튜닝]] does not resolve; [[다른 것]] does not resolve';
    expect(failureSentence({ code: 'broken-link', detail })).toEqual({ text: "없는 페이지 '쿼리 튜닝'으로 링크를 걸었어요.", link: '쿼리 튜닝' });
  });

  it('falls back when the broken-link detail has no link in it', () => {
    expect(failureSentence({ code: 'broken-link', detail: 'garbled' })).toEqual({ text: '없는 페이지로 링크를 걸었어요.', link: null });
  });
});

describe('attemptsNote', () => {
  const domain = '스터디' as DomainName;
  const f: MemoFailure = { attempts: 1, max: 3, code: 'llm', detail: '' };
  it('says every attempt was blocked on a failed memo', () =>
    expect(attemptsNote({ state: 'failed', domain, failure: { ...f, attempts: 3 }, finished: { day: '2026-10-29' } })).toBe('3번 모두 막혔어요'));
  it('counts the attempt in progress on a retrying memo', () => {
    expect(attemptsNote({ state: 'routed', domain, retry: f })).toBe('2번째 시도 중');
    expect(attemptsNote({ state: 'running', domain, retry: { ...f, attempts: 2 } })).toBe('3번째 시도 중');
  });
  it('says nothing right after a retry, and nothing on a memo that never failed', () => {
    expect(attemptsNote({ state: 'routed', domain, retry: null })).toBeNull();
    expect(attemptsNote({ state: 'held', domain })).toBeNull();
  });
});
