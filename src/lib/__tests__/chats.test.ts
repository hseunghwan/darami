import { parseChatId, rememberId } from '../../core/chat';
import type { DomainName } from '../../core/types';
import type { AnsweredTurn } from '../../jobs/engine';
import { chatLogLine, readingText, refusedText, saveButton, savedText } from '../chats';

const 스터디 = '스터디' as DomainName;
const CHAT = parseChatId('5d2c7a9e-1f3b-4c8d-9e0a-1b2c3d4e5f60')!;

it('Save answer reads its state from the memo book: save, saving, staged, saved with its page, gave up', () => {
  expect(saveButton(undefined, false)).toEqual({ label: '답 저장', on: false, saves: true, opens: null });
  expect(saveButton(undefined, true)).toEqual({ label: '저장하는 중', on: false, saves: false, opens: null });
  expect(saveButton({ state: 'staged', domain: 스터디 }, false)).toEqual({ label: '스터디에 저장하는 중', on: false, saves: false, opens: null });
  expect(saveButton({ state: 'saved', domain: 스터디, page: 'answers/2026-10-29 질문' }, false)).toEqual({ label: '저장됨', on: true, saves: false, opens: { domain: 스터디, page: 'answers/2026-10-29 질문' } });
  expect(saveButton({ state: 'gave-up', domain: 스터디, failure: { attempts: 3, max: 3, code: 'broken-link', detail: '' } }, false).label).toBe('저장하지 못했어요');
});

it('a refused save names its reason, a missing page by its label', () => {
  expect(savedText({ kind: 'refused', reason: { kind: 'missing-page', page: '스터디/wiki/개념/RAG' } })).toBe("'개념/RAG' 페이지가 위키에 없어서 답을 저장할 수 없어요.");
  expect(savedText({ kind: 'refused', reason: { kind: 'no-domain' } })).toMatch(/도메인이 없어요/);
  expect(savedText({ kind: 'staged', domain: 스터디, id: 'x' as never })).toBeNull();
  expect(savedText({ kind: 'failed', message: 'io' })).toMatch(/쓰지 못했어요/);
});

it('a question that kept no turn says why, and one that kept a turn or was stopped says nothing', () => {
  expect(refusedText({ kind: 'busy' })).toBe('이 대화의 앞 질문이 아직 끝나지 않았어요.');
  expect(refusedText({ kind: 'paused', problems: [] })).toMatch(/dotoriwiki\.yaml/);
  expect(refusedText({ kind: 'no-wiki' })).toMatch(/위키 폴더가 없어요/);
  expect(refusedText({ kind: 'cancelled' })).toBeNull();
});

it('reading names the last three pages read', () => {
  expect(readingText([])).toBe('위키를 읽는 중…');
  expect(readingText(['스터디/wiki/index.md', '스터디/wiki/RAG.md', 'CLAUDE.md', '스터디/wiki/개념/청크.md'])).toBe('RAG, CLAUDE, 개념/청크 읽는 중…');
});

it('the dev log line names the outcome, the turns and tools, the times, and the citations', () => {
  const turn: AnsweredTurn = {
    kind: 'answered', n: 0, askedAt: '', question: 'q', answer: 'a', cited: [{ domain: 스터디, page: 'RAG' }, { domain: 스터디, page: 'WAL 모드' }],
    links: new Map(), saveTo: 스터디, answerId: 'x' as never, memo: rememberId(CHAT, 0),
  };
  expect(chatLogLine({ kind: 'answered', turn, trace: { turns: 3, tools: ['read', 'search'], wrapped: false } }, { target: { kind: 'domain', domain: 스터디 }, ms: 8421, firstTextMs: 2100 }))
    .toBe('CHAT answered turns=3 tools=read,search ms=8421 first=2100 wrapped=no target=스터디 cited=스터디/wiki/RAG|스터디/wiki/WAL 모드');
  expect(chatLogLine({ kind: 'failed', turn: { kind: 'failed', n: 1, askedAt: '', question: 'q', failure: 'rate-limited', memo: rememberId(CHAT, 1) }, retryAt: null, trace: null }, { target: { kind: 'root' }, ms: 300, firstTextMs: null }))
    .toBe('CHAT failed:rate-limited turns=0 tools=- ms=300 first=- wrapped=no target=root cited=-');
  expect(chatLogLine({ kind: 'busy' }, { target: { kind: 'root' }, ms: 1, firstTextMs: null })).toBe('CHAT busy turns=0 tools=- ms=1 first=- wrapped=no target=root cited=-');
});
