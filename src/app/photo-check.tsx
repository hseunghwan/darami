/**
 * darami://photo-check, dev builds only. Runs the phone's own photo code, which jest cannot
 * reach, on the samples in src/media/samples.gen.ts: exifr on Hermes against made-by-dotoriwiki's
 * record, expo-crypto, and the expo-image-manipulator copy (orientation, the cap, never enlarging,
 * each format). Then the link reader on Hermes: the EUC-KR decoder, and linkedom with Readability
 * timed on a page of about 260 KB. Every line goes to console.log with a PHOTOCHECK prefix for
 * logcat, ending with `PHOTOCHECK done <passed>/<total>`. The Orientation 6 copy is shown on
 * screen, red on top when upright, and saved in the app's cache, whose path the log names.
 */

import { File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { Image, ScrollView, Text, View } from 'react-native';
import { COPY_JPEG, jpegSize, MODEL_JPEG, sniffPhoto } from '../core/photos';
import { decodeEucKr, decodeHtml } from '../links/charset';
import { readableText } from '../links/readable';
import { readExifTags } from '../media/exif';
import { phonePhotoTools } from '../media/phone';
import { FIXTURE_MEMO, fixtureMemoFile, fromBase64, SAMPLES } from '../media/samples';
import { Header, PrimaryButton, Screen } from '../ui/parts';
import { useTheme } from '../ui/theme';

type Say = (line: string) => void;
/** The Orientation 6 copy of the last run, for the screen. */
let shownUri: string | null = null;
type Case = { readonly name: string; readonly run: (say: Say) => Promise<void> };

const { jpeg, sha256 } = phonePhotoTools;

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(what);
}

const sizeOf = (b: Uint8Array | null) => {
  const s = b && jpegSize(b);
  return s ? `${s.width}×${s.height}` : 'none';
};

/** The copy of `b64`, which must be a JPEG of `want` with no EXIF left in it. */
async function copyOf(b64: string, want: string, spec = COPY_JPEG): Promise<Uint8Array> {
  const out = await jpeg(fromBase64(b64), spec);
  check(out !== null, 'did not decode');
  check(sniffPhoto(out!) === 'jpg', `came back as ${sniffPhoto(out!)}`);
  check(sizeOf(out) === want, `came back ${sizeOf(out)}, want ${want}`);
  check(Object.keys(await readExifTags(out!)).length === 0, 'EXIF was kept');
  return out!;
}

/** The 64×32 sample stretched to width×height on the device, as a JPEG to copy again. */
async function enlarged(width: number, height: number): Promise<Uint8Array> {
  const src = new File(Paths.cache, `photo-check-src-${Date.now()}.jpg`);
  await src.write(fromBase64(SAMPLES.orient1));
  const ref = await ImageManipulator.manipulate(src.uri).resize({ width, height }).renderAsync();
  const saved = await ref.saveAsync({ compress: 0.9, format: SaveFormat.JPEG });
  ref.release();
  src.delete();
  const f = new File(saved.uri);
  const b = await f.bytes();
  f.delete();
  return b;
}

const CASES: readonly Case[] = [
  {
    name: "exifr on Hermes: the fixture's photos give made-by-dotoriwiki's memo 5, byte for byte",
    run: async () => {
      const file = await fixtureMemoFile(sha256);
      if (file !== FIXTURE_MEMO.file) {
        const at = [...file].findIndex((c, i) => c !== FIXTURE_MEMO.file[i]);
        throw new Error(`differs at ${at}: ${JSON.stringify(file.slice(Math.max(0, at - 40), at + 40))}`);
      }
    },
  },
  {
    name: 'sha256: expo-crypto gives the digests the fixture recorded',
    run: async () => {
      check((await sha256(fromBase64(FIXTURE_MEMO.photos[0]))) === '5533251c374d11cb7bde57278d5c25729964eba70835ca327fdacb2ff45ec9a1', 'photo 1');
      check((await sha256(new Uint8Array())) === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'no bytes');
    },
  },
  {
    name: 'copy: Orientation 6 comes back 32×64 with no EXIF, upright (red on top, shown below)',
    run: async (say) => {
      const out = await copyOf(SAMPLES.orient6, '32×64');
      const f = new File(Paths.cache, `photo-check-orient6-${Date.now()}.jpg`);
      await f.write(out);
      say(`file ${f.uri}`);
      shownUri = f.uri;
    },
  },
  {
    name: 'copy: Orientation 3 comes back 64×32, 8 comes back 32×64, and 1 is unchanged',
    run: async () => {
      await copyOf(SAMPLES.orient3, '64×32');
      await copyOf(SAMPLES.orient8, '32×64');
      await copyOf(SAMPLES.orient1, '64×32');
    },
  },
  {
    name: 'copy: never enlarges, so 64×32 stays 64×32 at the 2048 cap and at the model size',
    run: async () => {
      await copyOf(SAMPLES.orient1, '64×32');
      await copyOf(SAMPLES.orient1, '64×32', MODEL_JPEG);
    },
  },
  {
    name: 'copy: the long edge comes to 2048 exactly, below and above the decode bound',
    run: async (say) => {
      for (const [w, h, want] of [[3000, 1500, '2048×1024'], [5000, 2500, '2048×1024'], [4032, 3024, '2048×1536'], [3024, 4032, '1536×2048']] as const) {
        const big = await enlarged(w, h);
        const t0 = Date.now();
        const out = await jpeg(big, COPY_JPEG);
        check(sizeOf(out) === want, `${w}×${h} came back ${sizeOf(out)}, want ${want}`);
        say(`${w}×${h} (${big.length} bytes) to ${want} (${out!.length} bytes) in ${Date.now() - t0} ms`);
      }
    },
  },
  {
    name: 'copy: PNG, WebP, and HEIC decode to a 64×32 JPEG with no EXIF',
    run: async (say) => {
      for (const k of ['png', 'webp', 'heic'] as const) {
        try {
          await copyOf(SAMPLES[k], '64×32');
          say(`${k} ok`);
        } catch (e) {
          throw new Error(`${k}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    },
  },
  {
    name: 'copy: bytes that are not an image answer null',
    run: async () => {
      check((await jpeg(new TextEncoder().encode('<html>not a photo</html>'), COPY_JPEG)) === null, 'answered bytes');
    },
  },
  {
    name: "model: a 2048×1536 copy comes back 1024×768, and its size as a data URL",
    run: async (say) => {
      const copy = await jpeg(await enlarged(4032, 3024), COPY_JPEG);
      const t0 = Date.now();
      const small = await jpeg(copy!, MODEL_JPEG);
      check(sizeOf(small) === '1024×768', `came back ${sizeOf(small)}`);
      say(`${small!.length} bytes, data URL about ${Math.ceil(small!.length / 3) * 4 + 23} characters, in ${Date.now() - t0} ms`);
    },
  },
  {
    name: 'EUC-KR on Hermes: a windows-949 page decodes whole, a syllable strict KS X 1001 lacks included',
    run: async () => {
      const bytes = Uint8Array.from([0x81, 0x41, 0x20, 0x8c, 0x63, 0xb9, 0xe6, 0xb0, 0xa2, 0xc7, 0xcf, 0x2c, 0x20, 0xc7, 0xd1, 0xb1, 0xdb, 0x20, 0x52, 0x41, 0x47, 0x20, 0xc3, 0xbb, 0xc5, 0xa9, 0x20, 0x35, 0x31, 0x32]);
      const want = '갂 똠방각하, 한글 RAG 청크 512';
      check(decodeEucKr(bytes) === want, `got ${JSON.stringify(decodeEucKr(bytes))}`);
      const page = decodeHtml('text/html; charset=ks_c_5601-1987', bytes);
      check(page.kind === 'text' && page.text === want, JSON.stringify(page));
    },
  },
  {
    name: 'reader on Hermes: linkedom and Readability read a page of about 260 KB, timed, the JS thread blocked meanwhile',
    run: async (say) => {
      const para = '<p>The queue lives in a single table, and every worker claims a row with one UPDATE statement. 도토리는 겨울에 다시 파낸다.</p>\n';
      const noise = '<script>window.__state = {"a": [1, 2, 3]};</script><style>.x { color: red }</style><nav><a href="/">Home</a></nav>\n';
      const html = `<html><head><title>Write-ahead logging</title></head><body>${noise.repeat(400)}<article><h1>Write-ahead logging</h1>${para.repeat(1900)}</article></body></html>`;
      const t0 = Date.now();
      const read = readableText(html);
      const ms = Date.now() - t0;
      check(read !== null && read.title === 'Write-ahead logging' && read.text.includes('UPDATE statement. 도토리는'), JSON.stringify(read?.title));
      say(`${Math.round(html.length / 1024)} KB of HTML to ${read!.text.length} characters in ${ms} ms`);
    },
  },
];

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function PhotoCheck() {
  const t = useTheme();
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [image, setImage] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setLog([]);
    setImage(null);
    shownUri = null;
    const say = (line: string) => {
      console.log(`PHOTOCHECK ${line}`);
      setLog((l) => [...l, line]);
    };
    let passed = 0;
    for (const [i, c] of CASES.entries()) {
      const t0 = Date.now();
      try {
        await c.run(say);
        passed++;
        say(`PASS ${i + 1} ${c.name} (${Date.now() - t0} ms)`);
      } catch (e) {
        say(`FAIL ${i + 1} ${c.name}: ${errText(e)}`);
      }
    }
    say(`done ${passed}/${CASES.length}`);
    setImage(shownUri);
    setBusy(false);
  }

  useEffect(() => {
    if (__DEV__) void run();
  }, []);

  if (!__DEV__) return <Redirect href="/" />;
  return (
    <Screen>
      <Header title="Photo check" back />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }}>
        <PrimaryButton label="Run photo check" busy={busy} onPress={() => void run()} />
        {image && (
          <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
            <Image source={{ uri: image }} style={{ width: 64, height: 128 }} accessibilityLabel="Orientation 6 copy" />
            <Text style={{ color: t.muted, fontSize: 12, flex: 1 }}>The Orientation 6 copy at twice its size. Upright means red on top and blue below.</Text>
          </View>
        )}
        {log.map((l, i) => (
          <Text key={i} selectable style={{ color: l.startsWith('FAIL') ? t.bad : t.fg, fontSize: 12, fontFamily: 'monospace' }}>
            {l}
          </Text>
        ))}
      </ScrollView>
    </Screen>
  );
}
