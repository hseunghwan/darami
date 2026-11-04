import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Fs } from '../../core/fs';
import { parseMemoFile, renderMemoFile } from '../../core/pages';
import { COPY_JPEG, jpegDataUrl, MODEL_JPEG, type AttachmentRequest } from '../../core/photos';
import type { MemoId } from '../../core/types';
import { nodeFs } from '../../fs/node';
import { memo, page, ulid, validFields } from '../../core/__tests__/helpers';
import { fakeModel, turn } from '../../agent/__tests__/fake-model';
import { bytes, GALAXY_JPEG, PLAIN_JPEG } from '../../media/__tests__/exif';
import { changed, copyingTools, engineOn, everyKill, memoryBook, memoryJournal, NO_SIGNAL, presetWiki, read, refusingTools, run, snapshot, template, type Ports } from './harness';

const FIXTURE = join(__dirname, '..', '..', 'core', '__tests__', 'fixtures', 'made-by-dotoriwiki');
const SEOUL = { lat: 37.5665, lon: 126.978, place: '중구 태평로1가', address: '서울특별시 중구 세종대로 110' };
const REQS: AttachmentRequest[] = [
  { n: 1, origin: 'gallery', place: '종로구 사직동', address: null },
  { n: 2, origin: 'camera', place: null, address: null },
];
const ID = ulid(5);
const PHOTOS = [bytes(GALAXY_JPEG), bytes(PLAIN_JPEG)];
const memo5 = () => memo(5, '친구랑 놀이터', { domain_hint: '일상', location: SEOUL, attachments: REQS });
const held = (photos: readonly (Uint8Array | null)[]) => async (n: number) => photos[n - 1] ?? null;
const INBOX = `inbox/${ID}.md`;
const original = (n: number) => `_originals/${ID}-${n}.jpg`;
const copy = (n: number) => `_attachments/${ID}-${n}.jpg`;

/** The inbox file dotoriwiki's accept wrote for memo 5: the fixture's raw copy before routing. */
function dotoriwikiInbox(): string {
  const p = parseMemoFile(readFileSync(join(FIXTURE, '일상', 'raw', `${ID}.md`), 'utf8'));
  assert.ok(p.ok);
  return renderMemoFile(p.value.memo, null);
}

/** Every create, createBytes, and remove, in order. */
function recording(inner: Fs): Fs & { readonly log: string[] } {
  const log: string[] = [];
  return {
    ...inner,
    log,
    create: (p, t) => (log.push(`create ${p}`), inner.create(p, t)),
    createBytes: (p, b) => (log.push(`createBytes ${p}`), inner.createBytes(p, b)),
    remove: (p) => (log.push(`remove ${p}`), inner.remove(p)),
  };
}

/** A preset wiki the engine has opened once, so its domains already have log.md and index.md. */
async function opened(): Promise<string> {
  const root = await presetWiki('ko');
  await engineOn(nodeFs(root), memoryJournal(), fakeModel({}));
  return root;
}

async function wiki(ports: Ports = {}) {
  const root = await opened();
  const book = memoryBook();
  const fs = recording(nodeFs(root));
  const open = (p: Ports = ports) => engineOn(fs, memoryJournal(), fakeModel({}), [], book, undefined, p);
  const engine = await open();
  fs.log.length = 0;
  return { root, fs, book, engine, open };
}

const bytesAt = (root: string, p: string) => new Uint8Array(readFileSync(join(root, ...p.split('/'))));

test('accept stores each original, then its copy, one photo at a time, and writes the memo last with dotoriwiki\'s record', async () => {
  const tools = copyingTools();
  const w = await wiki({ photos: tools });
  assert.deepEqual(await w.engine.accept(memo5(), held(PHOTOS)), { kind: 'created' });
  assert.deepEqual(w.fs.log, [
    'createBytes _originals/.nomedia', 'createBytes _attachments/.nomedia',
    `createBytes ${original(1)}`, `createBytes ${copy(1)}`, `createBytes ${original(2)}`, `createBytes ${copy(2)}`,
    `create ${INBOX}`,
  ]);
  assert.equal(read(w.root, INBOX), dotoriwikiInbox());
  for (const n of [1, 2]) {
    assert.deepEqual(bytesAt(w.root, original(n)), PHOTOS[n - 1], `original ${n} untouched`);
    assert.deepEqual(bytesAt(w.root, copy(n)), PHOTOS[n - 1], `copy ${n} from the copying fake`);
  }
  assert.deepEqual(tools.specs, [COPY_JPEG, COPY_JPEG]);
  assert.equal(read(w.root, '_attachments/.nomedia'), '');
  assert.deepEqual(await w.book.photoWrites(), [], 'the memo is whole, so its rows are gone');
  assert.deepEqual((await w.engine.book.memo(ID as MemoId))?.photos, [`${ID}-1.jpg`, `${ID}-2.jpg`]);
});

test('a resend changes nothing; other bytes for a stored photo conflict; a photo gone from the phone is fine only once stored', async () => {
  const w = await wiki();
  const before = snapshot(w.root);
  assert.deepEqual(await w.engine.accept(memo5(), held([PHOTOS[0]!, null])), { kind: 'photo-refused', n: 2, reason: 'missing' });
  assert.deepEqual(changed(before, snapshot(w.root)), ['_attachments/.nomedia', `_attachments/${ID}-1.jpg`, '_originals/.nomedia', `_originals/${ID}-1.jpg`], 'photo 1 stays for the next send; no memo');
  assert.deepEqual(await w.engine.accept(memo5(), held([null, PHOTOS[1]!])), { kind: 'created' }, 'photo 1 is stored, so the phone need not hold it');
  const filed = snapshot(w.root);
  assert.deepEqual(await w.engine.accept(memo5(), held(PHOTOS)), { kind: 'duplicate', at: 'inbox' });
  assert.deepEqual(await w.engine.accept(memo5()), { kind: 'duplicate', at: 'inbox' });
  assert.deepEqual(changed(filed, snapshot(w.root)), []);
  assert.equal(read(w.root, INBOX), dotoriwikiInbox());

  const other = memo(6, '다른 사진', { attachments: [{ n: 1, origin: 'share' }] });
  await w.engine.accept(other, held([PHOTOS[1]!]));
  const kept = snapshot(w.root);
  rmSync(join(w.root, 'inbox', `${ulid(6)}.md`));
  assert.deepEqual(await w.engine.accept(other, held([PHOTOS[0]!])), { kind: 'photo-refused', n: 1, reason: 'conflict' });
  assert.deepEqual(changed(kept, snapshot(w.root)), [`inbox/${ulid(6)}.md`], 'the stored photo kept, the memo not written');
});

test('a memo already past the inbox is a duplicate before any photo is read', async () => {
  const w = await wiki();
  await w.engine.accept(memo5(), held(PHOTOS));
  await w.engine.routeNext(NO_SIGNAL);
  w.fs.log.length = 0;
  let asked = 0;
  assert.deepEqual(await w.engine.accept(memo5(), async () => (asked++, null)), { kind: 'duplicate', at: { domain: '일상', state: 'routed' } });
  assert.deepEqual([asked, w.fs.log], [0, []]);
});

test('bytes that are not an image, or that the phone cannot decode, are refused with nothing left behind', async () => {
  const w = await wiki({ photos: refusingTools(1) });
  const before = snapshot(w.root);
  const html = new TextEncoder().encode('<html>');
  assert.deepEqual(await w.engine.accept(memo5(), held([html, PHOTOS[1]!])), { kind: 'photo-refused', n: 1, reason: 'unsupported' });
  assert.deepEqual(await w.engine.accept(memo5(), held(PHOTOS)), { kind: 'photo-refused', n: 2, reason: 'unsupported' });
  assert.deepEqual(changed(before, snapshot(w.root)), ['_attachments/.nomedia', `_attachments/${ID}-1.jpg`, '_originals/.nomedia', `_originals/${ID}-1.jpg`], 'photo 2\'s original removed with no copy');
});

test('a kill anywhere in an accept, and anywhere in the resend after it, leaves the bytes of an uncut accept', async () => {
  const fresh = await template(async () => ({ root: await opened(), store: memoryJournal() }));
  const send = async (fs: Fs) => {
    const r = await (await engineOn(fs, memoryJournal(), fakeModel({}))).accept(memo5(), held(PHOTOS));
    assert.ok(r.kind === 'created' || r.kind === 'duplicate', r.kind);
  };
  const clean = await fresh();
  await send(nodeFs(clean.root));
  const want = snapshot(clean.root);
  const seen = await everyKill({
    fresh,
    act: (fs) => send(fs),
    reopen: (fs) => send(fs),
    check: (root, _store, where) => {
      const got = snapshot(root);
      const memoFile = got.get(INBOX)!;
      // A memo create torn part way stays torn, as for any memo since P3; the router rejects it.
      if (memoFile !== want.get(INBOX)) assert.ok(want.get(INBOX)!.startsWith(memoFile) && memoFile !== '', `${where}: ${memoFile}`);
      assert.deepEqual(changed(want, got).filter((p) => p !== INBOX), [], where);
    },
  });
  assert.ok(seen > 40, `${seen} kills`);
}, 30_000);

test('photo files a memo never came for are swept a week on; a filed memo\'s and recent ones stay', async () => {
  const w = await wiki();
  await w.engine.accept(memo5(), held([PHOTOS[0]!, null]));
  const orphan = memo(7, 'x', { attachments: [{ n: 1, origin: 'gallery' }] });
  await w.engine.accept(orphan, held([PHOTOS[1]!]));
  rmSync(join(w.root, 'inbox', `${ulid(7)}.md`));
  const rows = await w.book.photoWrites();
  assert.deepEqual(rows.map((r) => r.path), [original(1), copy(1)], 'memo 7 settled its rows; memo 5 never got its memo file');

  await w.open({ now: () => new Date('2026-11-03T00:00:00Z') });
  assert.equal((await w.book.photoWrites()).length, 2, 'five days on, kept');
  assert.deepEqual(bytesAt(w.root, original(1)), PHOTOS[0]);

  await w.open({ now: () => new Date('2026-11-06T00:00:00Z') });
  assert.deepEqual(await w.book.photoWrites(), []);
  assert.throws(() => readFileSync(join(w.root, original(1))), /ENOENT/);
  assert.throws(() => readFileSync(join(w.root, copy(1))), /ENOENT/);
  assert.ok(readFileSync(join(w.root, `_originals/${ulid(7)}-1.jpg`)), 'a memo removed by hand after it was whole: no row names its photos');
});

test('a page may embed only a copy that is in _attachments', async () => {
  const late = ulid(9);
  const pageWith = (id: string, embed: string) => page(validFields(id, { type: 'theme' }), `본문.\n\n![[${embed}]]\n`);
  const w = await wiki();
  const model = fakeModel({
    ingest: (req, n) => {
      if (n === 2) return turn.finish('created');
      return JSON.stringify(req.input[0]).includes(`raw/${ID}.md`) ? turn.write('wiki/a.md', pageWith(ID, `${ID}-1.jpg`)) : turn.write('wiki/b.md', pageWith(late, `${late}-1.jpg`));
    },
  });
  const e = await engineOn(w.fs, memoryJournal(), model, [], w.book);
  await e.accept(memo5(), held(PHOTOS));
  await e.accept(memo(9, '사진 없는 메모', { domain_hint: '일상' }));
  for (let i = 0; i < 2; i++) await e.routeNext(NO_SIGNAL);
  assert.equal((await run(e, '일상')).kind, 'committed');
  const r = await run(e, '일상');
  assert.equal(r.kind, 'retrying');
  assert.match(JSON.stringify(r), new RegExp(`\\[\\[${late}-1\\.jpg\\]\\] does not resolve`));
});

test('ingest shows the model each copy at the model size after the prompt, leaves out a copy that is gone, and the classifier gets only text', async () => {
  const tools = copyingTools();
  const model = fakeModel({ classify: () => turn.route('일상', 0.9, '사진'), ingest: (_req, n) => (n === 1 ? turn.write('wiki/a.md', page(validFields(ID, { type: 'theme' }), '본문.\n')) : turn.finish('created')) });
  const root = await opened();
  const e = await engineOn(nodeFs(root), memoryJournal(), model, [], memoryBook(), undefined, { photos: tools });
  await e.accept({ ...memo5(), domainHint: null }, held(PHOTOS));
  await e.routeNext(NO_SIGNAL);
  const classify = model.requests.find((r) => r.role === 'classify')!;
  assert.doesNotMatch(JSON.stringify(classify.input), /input_image/);
  assert.match(JSON.stringify(classify.input), /사진 1: 2026-10-12 14:03, 종로구 사직동, samsung SM-S928N/);

  rmSync(join(root, copy(1)));
  tools.specs.length = 0;
  assert.equal((await run(e, '일상')).kind, 'committed');
  const first = model.requests.find((r) => r.role === 'ingest')!.input[0]!;
  assert.ok(first.type === 'message');
  const [text, ...images] = first.content;
  assert.deepEqual(images, [{ type: 'input_image', image_url: jpegDataUrl(PHOTOS[1]!) }], 'photo 2 only: photo 1\'s copy is gone');
  assert.ok(text?.type === 'input_text');
  assert.match(text.text, new RegExp(`원본에 사진 1장이 붙어 있다\\..*\\n- 사진 1: 중구 태평로1가 \\(\`!\\[\\[${ID}-2\\.jpg\\]\\]\`\\)`, 's'));
  assert.doesNotMatch(text.text, /Read로 열어/);
  assert.deepEqual(tools.specs, [MODEL_JPEG]);
});
