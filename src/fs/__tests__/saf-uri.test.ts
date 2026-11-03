import assert from 'node:assert/strict';
import type { WikiPath } from '../../core/layout';
import { documentUri, initialUriOf, parseSafTree, within, type SafTree } from '../saf-uri';

const at = (s: string) => s as WikiPath;
const PROBE = 'content://com.android.externalstorage.documents/tree/primary%3ADocuments%2Fprobe';

function tree(uri: string): SafTree {
  const t = parseSafTree(uri);
  assert.ok(t.ok, uri);
  return t.value;
}

test('parseSafTree takes the tree the picker gave on the emulator and drops its trailing slash', () => {
  const t = tree(`${PROBE}/`);
  assert.equal(t.uri, PROBE);
  assert.equal(t.baseId, 'primary:Documents/probe');
  assert.equal(t.name, 'probe');
  assert.deepEqual(tree(PROBE), t);
});

test('parseSafTree takes a volume root and an SD card folder', () => {
  const root = tree('content://com.android.externalstorage.documents/tree/primary%3A');
  assert.equal(root.baseId, 'primary:');
  assert.equal(root.name, 'primary');
  const card = tree('content://com.android.externalstorage.documents/tree/1A2B-3C4D%3ASync%2FWiki');
  assert.equal(card.baseId, '1A2B-3C4D:Sync/Wiki');
  assert.equal(card.name, 'Wiki');
});

test('parseSafTree refuses Downloads, cloud providers, document URIs, and anything else', () => {
  const refused = [
    'content://com.android.providers.downloads.documents/tree/msf%3A31',
    'content://com.android.providers.downloads.documents/tree/raw%3A%2Fstorage%2Femulated%2F0%2FDownload',
    'content://com.google.android.apps.docs.storage/tree/acc%3D1%3Bdoc%3Dencoded%3Dabc',
    'content://com.android.externalstorage.documents/document/primary%3ADocuments',
    'content://com.android.externalstorage.documents/tree/%E0%A4%A',
    'content://com.android.externalstorage.documents/tree/nocolon',
    'file:///sdcard/Documents',
    '',
  ];
  for (const uri of refused) assert.equal(parseSafTree(uri).ok, false, uri);
  assert.deepEqual(parseSafTree(refused[0]!), { ok: false, detail: 'com.android.providers.downloads.documents' });
});

test('documentUri builds the URIs the emulator answered for a file, a nested file, and a Hangul name with a space', () => {
  const t = tree(`${PROBE}/`);
  assert.equal(documentUri(t, at('hello.md')), `${PROBE}/document/primary%3ADocuments%2Fprobe%2Fhello.md`);
  assert.equal(documentUri(t, at('sub/deep.md')), `${PROBE}/document/primary%3ADocuments%2Fprobe%2Fsub%2Fdeep.md`);
  assert.equal(documentUri(t, at('미루기 아카이빙')), `${PROBE}/document/${encodeURIComponent('primary:Documents/probe/미루기 아카이빙')}`);
  assert.equal(documentUri(t, at('')), `${PROBE}/document/primary%3ADocuments%2Fprobe`);
  const root = tree('content://com.android.externalstorage.documents/tree/primary%3A');
  assert.equal(documentUri(root, at('wiki/a.md')), 'content://com.android.externalstorage.documents/tree/primary%3A/document/primary%3Awiki%2Fa.md');
});

test('within binds a folder under the same grant', () => {
  const t = within(tree(PROBE), at('run-1/case-2'));
  assert.equal(t.uri, PROBE);
  assert.equal(t.name, 'case-2');
  assert.equal(documentUri(t, at('a.md')), `${PROBE}/document/primary%3ADocuments%2Fprobe%2Frun-1%2Fcase-2%2Fa.md`);
});

test('the picker opens at the kept folder, or at Documents', () => {
  assert.equal(initialUriOf(tree(PROBE)), 'content://com.android.externalstorage.documents/document/primary%3ADocuments%2Fprobe');
  assert.equal(initialUriOf(null), 'content://com.android.externalstorage.documents/document/primary%3ADocuments');
});
