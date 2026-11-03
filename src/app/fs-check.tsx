/**
 * darami://fs-check, dev builds only. Runs the Fs contract (src/fs/contract.ts) on the SAF adapter,
 * which jest cannot reach, plus the SAF facts the node adapter does not share. Each case gets its
 * own scratch folder under a new run folder in the picked tree. Every line goes to console.log with
 * an FSCHECK prefix for logcat, ending with `FSCHECK done <passed>/<total>`.
 */

import { Directory, FileMode } from 'expo-file-system';
import { Redirect } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { ROOT, type WikiPath } from '../core/layout';
import { at, FS_CASES, same, type FsCase, type Seed } from '../fs/contract';
import { safFs } from '../fs/saf';
import { documentUri, parseSafTree, within, type SafTree } from '../fs/saf-uri';
import { Header, PrimaryButton, Screen } from '../ui/parts';
import { useTheme } from '../ui/theme';

const START = 'content://com.android.externalstorage.documents/document/primary%3ADocuments%2Ffs-check';

/** Node on Linux compares names byte for byte, so these hold only where the storage folds them. */
const SAF_CASES: readonly FsCase[] = [
  {
    name: 'SAF: a create whose name differs only in case answers exists and leaves no twin',
    run: async (fs, seed) => {
      await seed.file('c.md', 'first\n');
      same(await fs.create(at('C.md'), 'second\n'), 'exists', 'create');
      same(await fs.readText(at('C.md')), 'first\n', 'kept');
      same(await fs.list(ROOT), ['c.md'], 'no twin');
    },
  },
  {
    name: 'SAF: a name stored as NFD is found by its NFC path, and create inside it makes no NFC twin',
    run: async (fs, seed) => {
      await seed.file('스터디/a.md'.normalize('NFD'), 'a\n');
      same(await fs.readText(at('스터디/a.md')), 'a\n', 'readText');
      same(await fs.create(at('스터디/b.md'), 'b\n'), 'created', 'create');
      same(await fs.list(ROOT), ['스터디'], 'no folder twin');
      same(await fs.list(at('스터디')), ['a.md', 'b.md'], 'both files');
    },
  },
  {
    name: 'SAF: a write to C.md beside c.md replaces c.md and leaves one file named c.md',
    run: async (fs, seed) => {
      await seed.file('c.md', 'first, longer\n');
      await fs.write(at('C.md'), 'second\n');
      same(await fs.readText(at('c.md')), 'second\n', 'replaced');
      same(await fs.list(ROOT), ['c.md'], 'one file, its name kept');
    },
  },
  {
    name: 'SAF: a write inside a folder stored as NFD makes no NFC twin folder',
    run: async (fs, seed) => {
      await seed.file('미루기 아카이빙/wiki/a.md'.normalize('NFD'), 'a\n');
      await fs.write(at('미루기 아카이빙/wiki/b.md'), 'b\n');
      await fs.write(at('미루기 아카이빙/wiki/a.md'), 'a2\n');
      same(await fs.list(ROOT), ['미루기 아카이빙'], 'no folder twin');
      same(await fs.list(at('미루기 아카이빙/wiki')), ['a.md', 'b.md'], 'both files');
      same(await fs.readText(at('미루기 아카이빙/wiki/a.md')), 'a2\n', 'the NFD file replaced');
    },
  },
  {
    name: 'SAF: listTree names a file stored as NFD by its NFC path, and remove finds it there',
    run: async (fs, seed) => {
      await seed.file('스터디/wiki/인사이트/2026.md'.normalize('NFD'), 'i\n');
      same(await fs.listTree(at('스터디')), ['스터디/wiki/인사이트/2026.md'], 'NFC path');
      same(await fs.remove(at('스터디/wiki/인사이트/2026.md')), 'removed', 'removed by its NFC path');
      same(await fs.listTree(at('스터디')), [], 'gone');
    },
  },
];

const CASES = [...FS_CASES, ...SAF_CASES];

/** Writes around the port with the raw API, NFD names passed through as given. */
function safSeed(tree: SafTree): Seed {
  const raw = (rel: string) => documentUri(tree, rel as WikiPath);
  function folder(segs: readonly string[]): Directory {
    let dir = new Directory(raw(''));
    for (const [i, seg] of segs.entries()) {
      const next = new Directory(raw(segs.slice(0, i + 1).join('/')));
      dir = next.exists ? next : dir.createDirectory(seg);
    }
    return dir;
  }
  return {
    async file(rel, text) {
      const segs = rel.split('/');
      const made = folder(segs.slice(0, -1)).createFile(segs.at(-1)!, 'application/octet-stream');
      if (text === '') return;
      const handle = made.open(FileMode.Truncate);
      try {
        await handle.writeBytes(new TextEncoder().encode(text));
      } finally {
        handle.close();
      }
    },
    async folder(rel) {
      folder(rel.split('/'));
    },
    async dropRoot() {
      new Directory(raw('')).delete();
    },
  };
}

const errText = (e: unknown) => (e instanceof Error ? `${(e as { code?: string }).code ?? e.name}: ${e.message}` : String(e));

export default function FsCheck() {
  const t = useTheme();
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setLog([]);
    const say = (line: string) => {
      console.log(`FSCHECK ${line}`);
      setLog((l) => [...l, line]);
    };
    try {
      const parsed = parseSafTree((await Directory.pickDirectoryAsync(START)).uri);
      if (!parsed.ok) return say(`unsupported ${parsed.detail}`);
      const tree = parsed.value;
      const runName = `run-${Date.now()}`;
      const runDir = new Directory(documentUri(tree, ROOT)).createDirectory(runName);
      say(`tree ${tree.uri} run ${runDir.name} cases ${CASES.length}`);
      let passed = 0;
      for (const [i, c] of CASES.entries()) {
        const name = `case-${i + 1}`;
        try {
          new Directory(documentUri(tree, runName as WikiPath)).createDirectory(name);
          const caseTree = within(tree, `${runName}/${name}` as WikiPath);
          await c.run(safFs(caseTree), safSeed(caseTree));
          passed++;
          say(`PASS ${i + 1} ${c.name}`);
        } catch (e) {
          say(`FAIL ${i + 1} ${c.name}: ${errText(e)}`);
        }
      }
      say(`done ${passed}/${CASES.length}`);
    } catch (e) {
      say(`threw ${errText(e)}`);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (__DEV__) void run();
  }, []);

  if (!__DEV__) return <Redirect href="/" />;
  return (
    <Screen>
      <Header title="FS check" back />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }}>
        <PrimaryButton label="Run FS check" busy={busy} onPress={() => void run()} />
        {log.map((l, i) => (
          <Text key={i} selectable style={{ color: l.startsWith('FAIL') ? t.bad : t.fg, fontSize: 12, fontFamily: 'monospace' }}>
            {l}
          </Text>
        ))}
      </ScrollView>
    </Screen>
  );
}
