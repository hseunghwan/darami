import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { tidy } from '../../core/sources';
import { boundedHtml, PARSE_MAX_CHARS, readableText, stripInert } from '../readable';

const ARTICLE = readFileSync(join(__dirname, 'fixtures', 'article.html'), 'utf8');

/** dotoriwiki's readableText, with no strip and no bound. */
function dotoriwiki(html: string) {
  const article = new Readability(parseHTML(html).document as unknown as Document).parse();
  const text = tidy(article?.textContent ?? '');
  return text ? { title: (article?.title ?? '').trim(), text } : null;
}

const NOISY = `<html><head><title>Fallback</title><style>p { color: red }</style>
<script>var x = "<p>not text</p>";</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"NewsArticle","headline":"제목은 JSON-LD에서"}</script>
</head><body><!-- <p>comment</p> --><svg><text>icon</text></svg><article><h1>본문 제목</h1>
${'<p>도토리는 겨울에 다시 파낸다. 잊은 것은 참나무가 된다. '.repeat(12)}</p></article></body></html>`;

test('stripping inert markup first changes nothing Readability gives, the JSON-LD title included', () => {
  for (const html of [ARTICLE, NOISY]) assert.deepEqual(readableText(html), dotoriwiki(html));
  assert.equal(readableText(NOISY)?.title, '제목은 JSON-LD에서');
  assert.doesNotMatch(stripInert(NOISY), /color: red|not text|comment|icon/);
  assert.match(stripInert(NOISY), /application\/ld\+json/);
});

test('at most PARSE_MAX_CHARS reach the parser, cut before a tag', () => {
  const long = `<html><body><article>${'<p>단락 하나.</p>'.repeat(PARSE_MAX_CHARS / 10)}</article></body></html>`;
  const bounded = boundedHtml(long);
  assert.ok(bounded.length <= PARSE_MAX_CHARS);
  assert.ok(long.startsWith(bounded) && long[bounded.length] === '<');
  assert.equal(boundedHtml(ARTICLE), stripInert(ARTICLE));
});
