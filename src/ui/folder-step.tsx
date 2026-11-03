/** The onboarding step that picks the wiki folder; settings' Change folder runs it alone. */

import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { FolderState } from '../core/wiki';
import { actionsFor, isUsable, type Candidate, type FolderAction } from '../lib/folder';
import { checkFolder, keepFolder, pickFolder, setUpFolder, useApp } from '../state';
import { copy } from '../text';
import { Icon } from './icon';
import { Notice, PrimaryButton, QuietButton } from './parts';
import { useTheme } from './theme';

function label(action: FolderAction, c: Candidate | null): string {
  const state = c?.kind === 'checked' ? c.state.kind : null;
  switch (action) {
    case 'setUp':
      return state === 'unfinished' ? copy.folder.finish : copy.folder.setUp;
    case 'use':
      return state === 'broken' ? copy.folder.useAnyway : copy.folder.use;
    case 'recheck':
      return copy.folder.recheck;
    case 'pick':
      return c === null ? copy.folder.pick : state === 'unreachable' ? copy.folder.pickAgain : copy.folder.pickAnother;
  }
}

/** `onDone` runs once a folder is kept. With a folder already kept, the step opens on it. */
export function FolderStep({ repair, onDone }: { repair: boolean; onDone: () => void }) {
  const t = useTheme();
  const kept = useApp((a) => a.folder);
  const [picked, setPicked] = useState<Candidate | null>(null);
  const [busy, setBusy] = useState<FolderAction | null>(null);
  const [failed, setFailed] = useState(false);
  const candidate: Candidate | null = picked ?? (kept?.state ? { kind: 'checked', tree: kept.tree, state: kept.state } : null);
  const checking = picked === null && kept !== null && kept.state === null;
  const [primary, ...rest] = actionsFor(candidate);

  async function run(action: FolderAction) {
    if (busy) return;
    setBusy(action);
    setFailed(false);
    try {
      if (action === 'pick') {
        const c = await pickFolder();
        if (c) setPicked(c);
        return;
      }
      if (candidate?.kind !== 'checked') return;
      const { tree, state } = candidate;
      if (action === 'setUp') setPicked({ kind: 'checked', tree, state: await setUpFolder(tree) });
      else if (action === 'recheck') setPicked({ kind: 'checked', tree, state: await checkFolder(tree) });
      else if (isUsable(state)) {
        await keepFolder(tree, state);
        onDone();
      }
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <ScrollView contentContainerStyle={st.main}>
      <View style={{ gap: 8 }}>
        <Text style={[st.title, { color: t.fg }]}>{repair ? copy.folder.repairTitle : copy.folder.title}</Text>
        <Text style={[st.lede, { color: t.muted }]}>{copy.folder.lede}</Text>
      </View>

      {checking && (
        <Notice tone="plain">
          <Text style={{ color: t.muted, fontSize: 14, lineHeight: 21 }}>{copy.folder.checking}</Text>
        </Notice>
      )}
      {candidate && <FolderNotice candidate={candidate} />}
      {failed && <Bad text={copy.folder.failed} />}

      <View style={{ flex: 1 }} />

      <View style={{ gap: 8 }}>
        <PrimaryButton tall label={busy === primary ? copy.folder.busy[primary] : label(primary, candidate)} busy={busy === primary} onPress={() => void run(primary)} />
        {rest.map((a) => (
          <QuietButton key={a} label={busy === a ? copy.folder.busy[a] : label(a, candidate)} onPress={() => void run(a)} />
        ))}
      </View>
    </ScrollView>
  );
}

function FolderNotice({ candidate }: { candidate: Candidate }) {
  if (candidate.kind === 'unsupported') return <Bad text={copy.folder.unsupported} />;
  const { tree, state } = candidate;
  switch (state.kind) {
    case 'empty':
      return <Plain text={copy.folder.empty(tree.name)} />;
    case 'unfinished':
      return <Plain text={copy.folder.unfinished(tree.name)} />;
    case 'wiki':
      return <Found state={state} />;
    case 'broken':
      return <Bad text={copy.folder.problems(state.problems.length)} lines={state.problems.map((p) => `${p.key}: ${p.problem}. ${p.fix}`)} />;
    case 'foreign':
      return <Bad text={copy.folder.foreign(state.names.join(', '))} />;
    case 'unreachable':
      return <Bad text={copy.folder.unreachable(tree.name)} />;
  }
}

/** ConnectStep's look for found domains. */
function Found({ state }: { state: Extract<FolderState, { kind: 'wiki' }> }) {
  const t = useTheme();
  const domains = [...state.config.domains.keys()];
  return (
    <>
      <Notice tone="ok">
        <View accessibilityRole="text" style={st.row8}>
          <Icon name="checkCircle" size={18} color={t.okFg} />
          <Text style={{ color: t.okFg, fontSize: 14, fontWeight: '500' }}>{copy.folder.found(domains.length)}</Text>
        </View>
        <View style={st.wrap6}>
          {domains.map((d) => (
            <View key={d} style={[st.tag, { backgroundColor: t.bg2 }]}>
              <Text style={{ color: t.muted, fontSize: 12 }}>{d}</Text>
            </View>
          ))}
        </View>
      </Notice>
      {state.warnings.length > 0 && <Plain text={copy.folder.warnings(state.warnings.length)} lines={state.warnings.map((w) => `${w.key}: ${w.problem}`)} />}
    </>
  );
}

function Plain({ text, lines = [] }: { text: string; lines?: readonly string[] }) {
  const t = useTheme();
  return (
    <Notice tone="plain">
      <Text style={{ color: t.fg, fontSize: 14, lineHeight: 21 }}>{text}</Text>
      {lines.map((l) => (
        <Text key={l} style={{ color: t.muted, fontSize: 13, lineHeight: 19 }}>{l}</Text>
      ))}
    </Notice>
  );
}

function Bad({ text, lines = [] }: { text: string; lines?: readonly string[] }) {
  const t = useTheme();
  return (
    <Notice tone="bad">
      <View accessibilityRole="alert" style={st.row8top}>
        <Icon name="alert" size={18} color={t.bad} />
        <Text style={{ flex: 1, color: t.bad, fontSize: 14, lineHeight: 21 }}>{text}</Text>
      </View>
      {lines.map((l) => (
        <Text key={l} style={{ color: t.bad, fontSize: 13, lineHeight: 19 }}>{l}</Text>
      ))}
    </Notice>
  );
}

const st = StyleSheet.create({
  main: { flexGrow: 1, paddingTop: 40, paddingHorizontal: 24, paddingBottom: 24, gap: 24 },
  title: { fontSize: 24, fontWeight: '600', letterSpacing: -0.48 },
  lede: { fontSize: 15, lineHeight: 24 },
  row8: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  row8top: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  wrap6: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: { height: 26, paddingHorizontal: 10, borderRadius: 6, justifyContent: 'center' },
});
