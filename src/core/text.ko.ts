import { INGEST_VERDICTS, type IngestVerdict } from './ledger';
import type { Text } from './text';

const c = (s: string) => `\`${s}\``;

const verdictMeaning: { readonly [V in IngestVerdict]: string } = {
  created: '새 페이지',
  updated: '기존 페이지 수정',
  conflict: '기존 내용과 충돌',
  unchanged: '정리할 거리 없음',
};

const writeScope = '- 쓰기는 `wiki/` 아래에서만 한다. `raw/`, `CLAUDE.md`, 다른 도메인 폴더는 고치지 않는다.';

export const ko: Text = {
  collation: 'ko',
  acceptLanguage: 'ko,en;q=0.8',

  catalog: { heading: '## 도메인 목록', folder: '폴더', definition: '한 줄 정의' },
  pageTypes: { heading: '## 페이지 종류', example: '예시 파일', contents: '내용' },

  context: (project, branch) => `작성 맥락: 프로젝트 ${project}${branch ? `, 브랜치 ${branch}` : ''}`,
  photo: (n, facts) => `사진 ${n}: ${facts.join(', ') || '메타데이터 없음'}`,

  ingest: {
    rules: ({ date, fields, types }) => `## 서버가 정한 작업 규칙

- 오늘 날짜는 ${date}다. 만들거나 고친 페이지의 \`updated\`에 쓴다.
${writeScope}
- \`wiki/index.md\`와 \`wiki/log.md\`는 서버가 쓴다. 읽기만 한다.
- \`wiki/answers/\`는 저장된 질문 답이다. 정리 근거로 쓰지 않고 고치지 않는다.
- 페이지 frontmatter에는 ${fields.map(c).join(', ')}를 모두 단다. \`type\`은 ${types.map(c).join(', ')} 중 하나다.
- \`[[링크]]\`는 이미 있거나 이번에 만드는 위키 페이지에만 건다. 원본 id는 링크로 걸지 말고 \`sources\`와 본문에 글자로 적는다.
- 사진은 원본에 붙은 것만 \`![[파일명]]\`으로 넣는다. 사진에서 보이는 내용은 사진에서 본 것이라고 밝혀 적는다.
- 빈 파일이나 본문 없는 페이지를 만들지 않는다.
- 끝나면 \`finish\` 도구로 판정(\`verdict\`)을 돌려준다. 이것이 구조화된 응답이다. 판정은 다음 값 중 하나다.
${INGEST_VERDICTS.map((v) => `  - ${c(v)}: ${verdictMeaning[v]}`).join('\n')}`,
    prompt: ({ id, hasSource, photos, lastFailure }) =>
      [
        `원본 \`raw/${id}.md\` 하나를 정리 작업 순서대로 위키에 반영해라.`,
        hasSource ? `수집 자료 \`raw/${id}.source.md\`도 함께 읽는다.` : '',
        photos.length
          ? [
              `원본에 사진 ${photos.length}장이 붙어 있다. 각 파일을 Read로 열어 보고 무엇이 찍혔는지 정리에 반영한다. 페이지에 넣을 때는 \`![[파일명]]\`으로 쓴다.`,
              ...photos.map((p) => `- \`${p.path}\` (\`![[${p.file}]]\`) ${p.line}`),
            ].join('\n')
          : '',
        lastFailure ? `\n지난 시도는 서버 검사에서 실패해 되돌려졌다. 이유: ${lastFailure}\n같은 문제가 없도록 처음부터 다시 해라.` : '',
      ].filter(Boolean).join('\n'),
    workspace: (domain) => `## 작업 환경

- 파일은 도구로만 다룬다. \`list\`, \`read\`, \`search\`로 보고 \`write\`, \`edit\`으로 쓴다. 마지막에 \`finish\`를 한 번 부른다.
- 경로는 도메인 폴더 \`${domain}/\` 기준이다. 원본은 \`raw/<id>.md\`, 페이지는 \`wiki/<이름>.md\`, 다른 도메인 페이지는 \`../<도메인>/wiki/<이름>.md\`다. 다른 도메인은 읽기만 한다.
- \`write\`와 \`edit\`은 \`wiki/\` 아래 \`.md\` 파일에만 쓸 수 있다. 다른 곳에 쓰려 하면 이번 작업 전체가 실패하고 되돌려진다.
- 있는 페이지는 \`read\`로 연 다음에 \`write\`로 바꾼다. 일부만 고칠 때는 \`edit\`을 쓴다.`,
    nudge: '작업이 끝났으면 `finish`를 불러 판정을 돌려준다. 아직이면 도구로 계속한다.',
  },

  chatRules: (target) => `## 채팅 규칙

- 이 채팅은 위키를 읽기만 한다. 파일을 만들거나 고치지 않는다.
- ${target === 'root' ? '각 도메인의 `wiki/index.md`를' : '`wiki/index.md`를'} 먼저 읽고 필요한 페이지만 연다.
- 답의 근거가 된 위키 페이지를 \`[[도메인/wiki/페이지]]\` 형식으로 단다.
- 위키에 없는 내용은 없다고 말하고 지어내지 않는다.`,

  index: { title: (domain) => `# ${domain} 색인`, note: '서버가 페이지 frontmatter에서 만든다. 고치지 않는다.', other: '기타', answers: '저장된 답' },
  reviewTitle: '# 검토할 것',
  answer: { cited: '## 근거', none: '- 없음' },
  sidecar: {
    truncated: (total, kept) => `[… ${total}자 중 ${kept}자까지만 실음]`,
    fetchFailed: (detail) => `수집 실패: ${detail}`,
  },
};
