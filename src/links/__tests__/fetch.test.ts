import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import iconv from 'iconv-lite';
import { articleFetcher, type FetcherDeps } from '../fetch';

const ARTICLE = readFileSync(join(__dirname, 'fixtures', 'article.html'), 'utf8');
const NO_SIGNAL = new AbortController().signal;

const html = (body: BodyInit, type = 'text/html; charset=utf-8', status = 200) => new Response(body, { status, headers: type ? { 'content-type': type } : {} });

/** The fetcher on a fake `http`, a network that is up unless told, and timers that fire only when a test fires them. */
function fetcher(http: (url: string, init?: RequestInit) => Response | Promise<Response>, over: Partial<FetcherDeps> = {}) {
  const timers: (() => void)[] = [];
  const sent: { url: string; init?: RequestInit }[] = [];
  const f = articleFetcher({
    http: (async (url: string, init?: RequestInit) => (sent.push({ url, init }), http(url, init))) as typeof fetch,
    online: async () => true,
    setTimer: (_ms, fire) => (timers.push(fire), () => {}),
    ...over,
  });
  return { f, sent, fire: () => timers.forEach((t) => t()) };
}

test('a real page comes back as its readable main text, asked for with dotoriwiki\'s headers in the wiki\'s language', async () => {
  const { f, sent } = fetcher(() => html(ARTICLE));
  const r = await f('https://example.com/blog/2026/10/one-sqlite-queue/', 'ko', NO_SIGNAL);
  assert.ok(r.status === 'ok' && r.kind === 'article');
  assert.equal(r.title, 'We replaced 40 cron jobs with one SQLite queue');
  assert.match(r.text, /The queue lives in a single table, and every worker claims a row with one UPDATE \.\.\. RETURNING statement\./);
  assert.doesNotMatch(r.text, /<\/?(p|div|script)\b|\n{3,}/);
  const headers = new Headers(sent[0]!.init?.headers);
  assert.match(headers.get('user-agent')!, /Chrome\/141/);
  assert.equal(headers.get('accept-language'), 'ko,en;q=0.8');
  assert.equal(sent[0]!.init?.redirect, 'follow');
  await f('https://example.com/a', 'en', NO_SIGNAL);
  assert.equal(new Headers(sent[1]!.init?.headers).get('accept-language'), 'en,*;q=0.5');
});

test('non-HTML, HTTP errors, an empty article, oversized bodies, timeouts, and network errors are failed entries in dotoriwiki\'s words', async () => {
  const one = async (http: () => Response | Promise<Response>) => (await fetcher(http).f('https://example.com/a', 'ko', NO_SIGNAL));
  const failed = (detail: string) => ({ kind: 'article', status: 'failed', title: null, detail });
  assert.deepEqual(await one(() => html('%PDF-1.7', 'application/pdf')), failed('not HTML: application/pdf'));
  assert.deepEqual(await one(() => html(new Uint8Array([0x78]), '')), failed('not HTML: no content type'));
  assert.deepEqual(await one(() => html('nope', 'text/html', 404)), failed('HTTP 404'));
  assert.deepEqual(await one(() => html('<html><body></body></html>')), failed('no readable text'));
  let pulled = 0;
  const big = new ReadableStream({ pull: (c) => void (pulled++, c.enqueue(new Uint8Array(1024 * 1024).fill(0x61))) });
  assert.deepEqual(await one(() => new Response(big, { headers: { 'content-type': 'text/html' } })), failed('body over 5 MB'));
  assert.ok(pulled <= 7, `stopped reading at the cap, after ${pulled} chunks`);
  assert.deepEqual(await one(() => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))), failed('fetch failed (ECONNRESET)'));
  assert.deepEqual(await one(() => Promise.reject(new TypeError('Network request failed'))), failed('Network request failed'));

  const slow = fetcher((_url, init) => new Promise((_, no) => init?.signal?.addEventListener('abort', () => no(new Error('Aborted')))));
  const pending = slow.f('https://example.com/a', 'ko', NO_SIGNAL);
  slow.fire();
  assert.deepEqual(await pending, failed('timed out'));
});

test('no response with no network is offline, not a failed entry', async () => {
  const down = fetcher(() => Promise.reject(new TypeError('Network request failed')), { online: async () => false });
  assert.deepEqual(await down.f('https://example.com/a', 'ko', NO_SIGNAL), { status: 'offline' });
  const asked: string[] = [];
  const up = fetcher(() => html('nope', 'text/html', 503), { online: async () => (asked.push('online'), false) });
  assert.equal((await up.f('https://example.com/a', 'ko', NO_SIGNAL)).status, 'failed', 'a response came, so the network was there');
  assert.deepEqual(asked, []);
});

test('a YouTube link is a failed video entry, and nothing is fetched', async () => {
  const { f, sent } = fetcher(() => html(ARTICLE));
  for (const url of ['https://youtu.be/abc', 'https://www.youtube.com/watch?v=abc', 'https://m.youtube.com/watch?v=x', 'https://user@music.youtube.com:443/x']) {
    assert.deepEqual(await f(url, 'ko', NO_SIGNAL), { kind: 'video', status: 'failed', title: null, detail: 'videos are not fetched on the phone' }, url);
  }
  assert.deepEqual(sent, []);
  assert.equal((await f('https://notyoutube.com/watch', 'ko', NO_SIGNAL)).status, 'ok');
});

test('an EUC-KR page decodes to Korean, and a charset the phone cannot read is a failed entry', async () => {
  const body = new Uint8Array(iconv.encode(`<html><head><meta charset="euc-kr"><title>t</title></head><body><article><p>갂 한글 ${'filler text. '.repeat(60)}</p></article></body></html>`, 'cp949'));
  const r = await fetcher(() => html(body, 'text/html')).f('https://example.co.kr/', 'ko', NO_SIGNAL);
  assert.ok(r.status === 'ok');
  assert.match(r.text, /^갂 한글/);
  const sjis = Uint8Array.from([...new TextEncoder().encode('<html><body><p>'), 0x82, 0xa0, ...new TextEncoder().encode('</p></body></html>')]);
  assert.deepEqual(await fetcher(() => html(sjis, 'text/html; charset=x-unknown-jis')).f('https://example.jp/', 'ko', NO_SIGNAL), { kind: 'article', status: 'failed', title: null, detail: 'charset x-unknown-jis is not supported' });
});
