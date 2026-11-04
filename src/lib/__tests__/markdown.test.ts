import { markdownBlocks, markdownSpans, pageLabel } from '../markdown';

const render = (text: string) => markdownSpans(text).map((s) => (s.kind === 'text' ? s.text : `<${s.kind}>${s.text}</${s.kind}>`)).join('');

it('renders bold, bullets, headings and wikilinks from a chat answer', () => {
  const answer = '## 요약\n- **직접 해본 결과:** 512 토큰으로 줄였어요.\n  - 기록에 없는 것\n\n근거: [[스터디/wiki/RAG]], [[인사이트/2026|2026 인사이트]]';
  expect(render(answer)).toBe(
    '<bold>요약</bold>\n• <bold>직접 해본 결과:</bold> 512 토큰으로 줄였어요.\n  • 기록에 없는 것\n\n근거: <link>RAG</link>, <link>인사이트/2026</link>',
  );
});

it('keeps what a link names, as extractWikilinks does, so a screen can open it', () => {
  expect(markdownSpans('[[스터디/wiki/RAG|검색]] [[ME#습관]] [[a.md]]').filter((s) => s.kind === 'link')).toEqual([
    { kind: 'link', text: 'RAG', target: '스터디/wiki/RAG' },
    { kind: 'link', text: 'ME', target: 'ME' },
    { kind: 'link', text: 'a', target: 'a' },
  ]);
});

it('shows an embedded photo by its file name, not as a link', () => {
  expect(markdownSpans('보기: ![[A-1.jpg]]')).toEqual([{ kind: 'text', text: '보기: ' }, { kind: 'embed', text: 'A-1.jpg' }]);
});

it('leaves unmatched markers as typed, so a half-streamed answer still reads', () => {
  expect(render('정확도가 **올')).toBe('정확도가 **올');
  expect(render('[[스터디/wiki/R')).toBe('[[스터디/wiki/R');
});

it('labels cited pages without the domain prefix', () => {
  expect(pageLabel('스터디/wiki/개념/RAG')).toBe('개념/RAG');
  expect(pageLabel('인사이트/2026')).toBe('인사이트/2026');
});

it('lays a page out as text blocks around pictures, a picture being an embed alone on its line', () => {
  const blocks = markdownBlocks('친구랑 놀이터에 갔다.\n사진에서 본 그네.\n\n![[A-1.jpg]]\n![[A-2.jpg|300]]\n\n보기: ![[A-3.jpg]] 끝\n![[노트]]');
  expect(blocks.map((b) => (b.kind === 'photo' ? `photo ${b.file}` : `text ${b.spans.map((s) => (s.kind === 'text' ? s.text : `<${s.kind}>${s.text}`)).join('')}`))).toEqual([
    'text 친구랑 놀이터에 갔다.\n사진에서 본 그네.',
    'photo A-1.jpg',
    'photo A-2.jpg',
    'text 보기: <embed>A-3.jpg 끝\n<embed>노트',
  ]);
  expect(markdownBlocks('')).toEqual([]);
});
