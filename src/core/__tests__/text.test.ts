import assert from 'node:assert/strict';
import { renderLine, type LedgerLine } from '../ledger';
import { renderIndex } from '../pages';
import { textFor, type Text } from '../text';

const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;

/** Every template with sample arguments, so a test sees the text a run would. */
function everything(t: Text): string[] {
  const photos = [{ path: '/w/_attachments/A-1.jpg', file: 'A-1.jpg', line: t.photo(1, ['2026-10-29 08:10', 'Chicago']) }];
  const pages = [
    { pathUnderWiki: 'RAG.md', name: 'RAG', type: 'concept', summary: 'Retrieval' },
    { pathUnderWiki: 'x.md', name: 'x', type: null, summary: '' },
    { pathUnderWiki: 'answers/Q.md', name: 'Q', type: 'answer', summary: 'Q?' },
  ];
  return [
    t.catalog.heading, t.catalog.folder, t.catalog.definition, t.pageTypes.heading, t.pageTypes.example, t.pageTypes.contents,
    t.context('notes-app', 'main'), t.photo(2, []),
    t.ingest.rules({ date: '2026-10-29', fields: ['type', 'summary'], types: ['concept', 'case'] }),
    t.ingest.prompt({ id: 'A', hasSource: true, photos, lastFailure: 'empty x.md: page has no body' }),
    t.ingest.prompt({ id: 'A', hasSource: false, photos: [...photos, ...photos], lastFailure: null }),
    t.chatRules('root'), t.chatRules('domain'),
    renderIndex('learning', pages, ['concept'], t),
    t.reviewTitle, t.answer.cited, t.answer.none,
    t.sidecar.truncated(40_000, 30_000), t.sidecar.fetchFailed('HTTP 500'),
  ];
}

test('an English wiki gets no Korean from any template', () => {
  for (const s of everything(textFor('en'))) assert.doesNotMatch(s, HANGUL, s);
  const gaveUp: LedgerLine = { date: '2026-10-29', job: 'ingest', id: 'A', outcome: { kind: 'gave-up', attempt: 3, max: 3, reason: 'empty x.md: page has no body' } };
  assert.doesNotMatch(renderLine('en', gaveUp), HANGUL);
});

const before = (date: string, types: readonly string[]) => `## 서버가 정한 작업 규칙

- 오늘 날짜는 ${date}다. 만들거나 고친 페이지의 \`updated\`에 쓴다.
- 쓰기는 \`wiki/\` 아래에서만 한다. \`raw/\`, \`CLAUDE.md\`, 다른 도메인 폴더는 고치지 않는다.
- \`wiki/index.md\`와 \`wiki/log.md\`는 서버가 쓴다. 읽기만 한다.
- \`wiki/answers/\`는 저장된 질문 답이다. 정리 근거로 쓰지 않고 고치지 않는다.
- 페이지 frontmatter에는 \`type\`, \`summary\`를 모두 단다. \`type\`은 ${types.map((t) => `\`${t}\``).join(', ')} 중 하나다.
- \`[[링크]]\`는 이미 있거나 이번에 만드는 위키 페이지에만 건다. 원본 id는 링크로 걸지 말고 \`sources\`와 본문에 글자로 적는다.
- 사진은 원본에 붙은 것만 \`![[파일명]]\`으로 넣는다. 사진에서 보이는 내용은 사진에서 본 것이라고 밝혀 적는다.
- 빈 파일이나 본문 없는 페이지를 만들지 않는다.
- 끝나면 판정(\`verdict\`)과 만들거나 고친 페이지의 \`wiki/\` 기준 경로 목록(\`pages\`)을 구조화된 응답으로 돌려준다.`;

test('a Korean wiki keeps the rules it had, plus the verdict list the id enum needs', () => {
  const now = textFor('ko').ingest.rules({ date: '2026-10-29', fields: ['type', 'summary'], types: ['concept', 'case'] });
  const old = before('2026-10-29', ['concept', 'case']);
  assert.ok(now.startsWith(old), now);
  assert.equal(now.slice(old.length), ' 판정은 다음 값 중 하나다.\n  - `created`: 새 페이지\n  - `updated`: 기존 페이지 수정\n  - `conflict`: 기존 내용과 충돌\n  - `unchanged`: 정리할 거리 없음');
});
