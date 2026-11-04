/**
 * The FetchSource port on the phone's fetch: dotoriwiki's sourceFetcher and fetchArticle without
 * yt-dlp. It loads no native module, so jest runs it with a fake `http`; state.ts binds the real
 * fetch and the network probe.
 */

import { ARTICLE_FETCH, FETCH_DETAIL, kindOf, type FetchedSource, type FetchSource, type LinkResult, type SourceKind } from '../core/sources';
import { textFor } from '../core/text';
import { decodeHtml } from './charset';
import { readableText } from './readable';

export type FetcherDeps = {
  readonly http: typeof fetch;
  /** False when the phone has no network. Asked only after a request got no response. */
  readonly online: () => Promise<boolean>;
  /** The 15 s timer is ours: React Native rejects every abort alike, so `timed out` comes from a flag. */
  readonly setTimer: (ms: number, fire: () => void) => () => void;
};

const failed = (kind: SourceKind, detail: string): FetchedSource => ({ kind, status: 'failed', title: null, detail });

/** dotoriwiki's describeError: `fetch failed (ECONNRESET)`, or React Native's `Network request failed`. */
function describeError(e: unknown): string {
  const err = e as (Error & { cause?: { code?: string; message?: string } }) | null;
  if (err?.name === 'TimeoutError') return FETCH_DETAIL.timedOut;
  return FETCH_DETAIL.error(err?.message ?? String(e), err?.cause?.code ?? err?.cause?.message ?? null);
}

/** The body up to `max` bytes, read as a stream so the rest is never downloaded. null past the cap. */
async function readCapped(res: Response, max: number, abort: AbortController): Promise<Uint8Array | null> {
  const reader = res.body?.getReader();
  if (!reader) {
    const whole = new Uint8Array(await res.arrayBuffer());
    return whole.length > max ? null : whole;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      abort.abort();
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** One frame paints before the parse, which blocks the JS thread. */
const yieldFrame = () => new Promise<void>((done) => setTimeout(done, 0));

async function article(res: Response, abort: AbortController): Promise<FetchedSource> {
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return failed('article', FETCH_DETAIL.http(res.status));
  }
  const type = res.headers.get('content-type') ?? '';
  if (!/text\/html|application\/xhtml\+xml/i.test(type)) {
    await res.body?.cancel().catch(() => undefined);
    return failed('article', FETCH_DETAIL.notHtml(type));
  }
  const bytes = await readCapped(res, ARTICLE_FETCH.maxBytes, abort);
  if (!bytes) return failed('article', FETCH_DETAIL.tooBig);
  const html = decodeHtml(type, bytes);
  if (html.kind === 'unsupported') return failed('article', FETCH_DETAIL.charset(html.label));
  await yieldFrame();
  const read = readableText(html.text);
  return read ? { kind: 'article', status: 'ok', title: read.title, text: read.text } : failed('article', FETCH_DETAIL.unreadable);
}

export function articleFetcher(deps: FetcherDeps): FetchSource {
  return async (url, locale, signal): Promise<LinkResult> => {
    if (kindOf(url) === 'video') return failed('video', FETCH_DETAIL.video);
    const abort = new AbortController();
    let timedOut = false;
    const cancel = deps.setTimer(ARTICLE_FETCH.timeoutMs, () => {
      timedOut = true;
      abort.abort();
    });
    const follow = () => abort.abort();
    if (signal.aborted) abort.abort();
    signal.addEventListener('abort', follow);
    try {
      let res: Response;
      try {
        res = await deps.http(url, {
          headers: { 'user-agent': ARTICLE_FETCH.userAgent, accept: ARTICLE_FETCH.accept, 'accept-language': textFor(locale).acceptLanguage },
          redirect: 'follow',
          signal: abort.signal,
        });
      } catch (e) {
        if (timedOut) return failed('article', FETCH_DETAIL.timedOut);
        if (!signal.aborted && !(await deps.online())) return { status: 'offline' };
        return failed('article', describeError(e));
      }
      return await article(res, abort);
    } catch (e) {
      return failed('article', timedOut ? FETCH_DETAIL.timedOut : describeError(e));
    } finally {
      cancel();
      signal.removeEventListener('abort', follow);
    }
  };
}
