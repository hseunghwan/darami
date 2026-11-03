import { INGEST_VERDICTS, type IngestVerdict } from './ledger';
import type { Text } from './text';

const c = (s: string) => `\`${s}\``;

const verdictMeaning: { readonly [V in IngestVerdict]: string } = {
  created: 'you made a new page',
  updated: 'you changed an existing page',
  conflict: 'the memo contradicts what a page says',
  unchanged: 'nothing in the memo is worth keeping',
};

const writeScope = '- Write only under `wiki/`. Do not change `raw/`, `CLAUDE.md`, or any other domain folder.';

export const en: Text = {
  collation: 'en',
  acceptLanguage: 'en,*;q=0.5',

  catalog: { heading: '## Domains', folder: 'Folder', definition: 'What belongs here' },
  pageTypes: { heading: '## Page types', example: 'Example file', contents: 'What a page holds' },

  context: (project, branch) => `Written while working in project ${project}${branch ? `, branch ${branch}` : ''}`,
  photo: (n, facts) => `Photo ${n}: ${facts.join(', ') || 'no metadata'}`,

  ingest: {
    rules: ({ date, fields, types }) => `## Rules the server sets

- Today is ${date}. Put it in \`updated\` on every page you create or change.
${writeScope}
- The server writes \`wiki/index.md\` and \`wiki/log.md\`. Only read them.
- \`wiki/answers/\` holds saved chat answers. Do not build pages on them, and do not change them.
- Give every page frontmatter with ${fields.map(c).join(', ')}. \`type\` is one of ${types.map(c).join(', ')}.
- Link with \`[[…]]\` only to wiki pages that exist or that you create in this run. Write memo ids as plain text in \`sources\` and in the body, not as links.
- Embed only the photos attached to the memo, as \`![[file name]]\`. When a page states something you saw in a photo, say that it comes from the photo.
- Do not create empty files or pages without a body.
- When you are done, call the \`finish\` tool with \`verdict\`. That is your structured answer. \`verdict\` is one of:
${INGEST_VERDICTS.map((v) => `  - ${c(v)}: ${verdictMeaning[v]}`).join('\n')}`,
    prompt: ({ id, hasSource, photos, lastFailure }) =>
      [
        `Work the memo \`raw/${id}.md\` into the wiki, following your rules for working a memo.`,
        hasSource ? `Also read what was collected from its links, in \`raw/${id}.source.md\`.` : '',
        photos.length
          ? [
              `The memo has ${photos.length === 1 ? 'one photo' : `${photos.length} photos`} attached. Open each file with Read and use what it shows. To put a photo on a page, write \`![[file name]]\`.`,
              ...photos.map((p) => `- \`${p.path}\` (\`![[${p.file}]]\`) ${p.line}`),
            ].join('\n')
          : '',
        lastFailure ? `\nThe last attempt failed the server's checks and was rolled back. Reason: ${lastFailure}\nStart over, and avoid the same problem.` : '',
      ].filter(Boolean).join('\n'),
    workspace: (domain) => `## Workspace

- You work on files only through tools: look with \`list\`, \`read\`, and \`search\`, write with \`write\` and \`edit\`, and call \`finish\` once at the end.
- Paths are relative to the domain folder \`${domain}/\`. The memo is \`raw/<id>.md\`, pages are \`wiki/<name>.md\`, and another domain's page is \`../<domain>/wiki/<name>.md\`. Other domains are read-only.
- \`write\` and \`edit\` work only on \`.md\` files under \`wiki/\`. Writing anywhere else fails the whole run, and every change is rolled back.
- Open an existing page with \`read\` before you replace it with \`write\`. Use \`edit\` to change part of it.`,
    nudge: 'If you are done, call `finish` with your verdict. If not, go on with the tools.',
  },

  chatRules: (target) => `## Chat rules

- This chat only reads the wiki. Do not create or change files.
- Read ${target === 'root' ? "each domain's `wiki/index.md`" : '`wiki/index.md`'} first, then open only the pages you need.
- Cite each wiki page your answer rests on as \`[[domain/wiki/page]]\`.
- If the wiki does not say it, say so. Do not make it up.`,

  index: { title: (domain) => `# ${domain} index`, note: 'The server builds this page from page frontmatter. Do not edit it.', other: 'Other', answers: 'Saved answers' },
  reviewTitle: '# To review',
  answer: { cited: '## Cited pages', none: '- none' },
  sidecar: {
    truncated: (total, kept) => `[… kept the first ${kept} of ${total} characters]`,
    fetchFailed: (detail) => `Fetch failed: ${detail}`,
  },
};
