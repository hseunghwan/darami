import assert from 'node:assert/strict';
import iconv from 'iconv-lite';
import { decodeEucKr, decodeHtml, decodeWindows1252, isUtf8, labelOf } from '../charset';

const html = (s: string) => new TextEncoder().encode(s);

test('every EUC-KR lead and trail pair decodes as windows-949 does, an unmapped pair as WHATWG says (else run npm run charset)', () => {
  let mapped = 0;
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x00; trail <= 0xff; trail++) {
      const want = iconv.decode(Buffer.from([lead, trail]), 'cp949');
      const got = decodeEucKr(Uint8Array.from([lead, trail]));
      if (trail >= 0x41 && trail <= 0xfe && want.length === 1 && want !== '�') {
        mapped++;
        assert.equal(got, want, `${lead.toString(16)} ${trail.toString(16)}`);
      } else {
        assert.equal(got, `�${trail < 0x80 ? String.fromCharCode(trail) : ''}`, `${lead.toString(16)} ${trail.toString(16)} unmapped`);
      }
    }
  }
  assert.equal(mapped, 17_048);
  assert.equal(decodeEucKr(Uint8Array.from([0x80, 0x41, 0xff, 0xb0])), '�A��', 'a bad lead, and a lead cut off at the end');
});

test('a Korean page in windows-949 decodes whole, syllables strict KS X 1001 lacks included', () => {
  const text = '<p>갂 똠 햏 쀍, 한글 RAG 청크 512</p>';
  const bytes = new Uint8Array(iconv.encode(text, 'cp949'));
  assert.equal(decodeEucKr(bytes), text);
  assert.notEqual(new TextDecoder('euc-kr').decode(bytes), text, 'Node\'s own decoder, dotoriwiki\'s, garbles it');
  assert.deepEqual(decodeHtml('text/html; charset=EUC-KR', bytes), { kind: 'text', text });
  assert.deepEqual(decodeHtml('text/html', new Uint8Array([...html('<meta charset="ks_c_5601-1987">'), ...bytes])), { kind: 'text', text: `<meta charset="ks_c_5601-1987">${text}` });
});

test('windows-1252 and its labels, latin1 among them, decode 0x80–0x9F as WHATWG does', () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  assert.equal(decodeWindows1252(all), new TextDecoder('windows-1252').decode(all));
  assert.equal((decodeHtml('text/html; charset=iso-8859-1', Uint8Array.from([0x93, 0x41, 0x94, 0xe9])) as { text: string }).text, '“A”é');
});

test('the label comes from the header, then a meta tag in the first 4 KB, then utf-8', () => {
  assert.equal(labelOf('text/html; charset="Shift_JIS"', html('<meta charset="euc-kr">')), 'shift_jis');
  assert.equal(labelOf('text/html', html('<html><head><meta http-equiv="content-type" content="text/html; charset=euc-kr">')), 'euc-kr');
  assert.equal(labelOf('text/html', html(`${' '.repeat(4096)}<meta charset="euc-kr">`)), 'utf-8', 'past 4 KB');
  assert.equal(labelOf('', html('<p>x</p>')), 'utf-8');
});

test('a label the phone cannot decode is read as utf-8 only when the bytes are, else the page is unsupported', () => {
  assert.deepEqual(decodeHtml('text/html; charset=utf-8', html('도토리')), { kind: 'text', text: '도토리' });
  assert.deepEqual(decodeHtml('text/html; charset=nonsense', html('<p>도토리</p>')), { kind: 'text', text: '<p>도토리</p>' });
  const sjis = Uint8Array.from([0x82, 0xa0, 0x82, 0xa2]);
  const r = decodeHtml('text/html; charset=x-sjis-unknown', sjis);
  assert.deepEqual(r, { kind: 'unsupported', label: 'x-sjis-unknown' });
});

test('isUtf8 follows RFC 3629', () => {
  for (const ok of ['', 'abc', '도토리', '🌰', '\u{10FFFF}']) assert.ok(isUtf8(html(ok)), ok);
  for (const bad of [[0x80], [0xc0, 0x80], [0xc3], [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xf5, 0x80, 0x80, 0x80], [0xe2, 0x82]]) {
    assert.ok(!isUtf8(Uint8Array.from(bad)), JSON.stringify(bad));
  }
});
