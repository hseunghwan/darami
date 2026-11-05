import { useLocalSearchParams, usePreventRemove } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';
import type { WikiConfig } from '../../core/config';
import { addedName, draftProblems, type ConfigEdit, type RootEntry } from '../../core/config-edit';
import { draftFrom, editedText, openDomain, problemsAt, rowsOf, type Opened, type TypeRow } from '../../lib/domains';
import { editDomains, freshWikiConfig, rootEntry, useWikiConfig } from '../../state';
import { Icon } from '../../ui/icon';
import { Card, goBack, Header, Notice, PrimaryButton, Screen, SectionTitle, SmallButton } from '../../ui/parts';
import { useTheme } from '../../ui/theme';
import { copy } from '../../text';

/** One domain's form, or a new domain's when the route names none. A domain may be named `new`, so the name is a param. */
export default function DomainScreen() {
  const t = useTheme();
  const { name } = useLocalSearchParams<{ name?: string }>();
  const config = useWikiConfig();
  const [opened, setOpened] = useState(() => openDomain(config, name));
  const [generation, setGeneration] = useState(0);

  // At a cold start the wiki is still being read when the form opens.
  useEffect(() => {
    if (opened.kind === 'missing' && config) setOpened(openDomain(config, name));
  }, [config]);

  if (opened.kind === 'missing') {
    return (
      <Screen>
        <Header title={name ?? copy.domains.title} back />
        <View style={st.main}>
          <Notice tone="plain">
            <Text style={{ color: t.muted, fontSize: 14, lineHeight: 21 }}>{config ? copy.domains.missing : copy.domains.notWiki}</Text>
          </Notice>
        </View>
      </Screen>
    );
  }
  return (
    <DomainForm
      key={generation}
      opened={opened}
      config={config}
      onReload={async () => {
        setOpened(openDomain(await freshWikiConfig(), name));
        setGeneration((g) => g + 1);
      }}
    />
  );
}

function DomainForm({ opened, config, onReload }: { opened: Exclude<Opened, { kind: 'missing' }>; config: WikiConfig | null; onReload: () => void }) {
  const t = useTheme();
  const [newName, setNewName] = useState('');
  const [description, setDescription] = useState(opened.draft.description);
  const [rows, setRows] = useState<readonly TypeRow[]>(() => rowsOf(opened));
  const nextKey = useRef(rows.length);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<{ readonly text: string; readonly stale: boolean } | null>(null);
  const atRoot = useRootEntry(opened.kind === 'new' ? addedName(newName) : '');

  const want = draftFrom(description, rows);
  const edit: Exclude<ConfigEdit, { kind: 'fallback' }> = opened.kind === 'new' ? { kind: 'add', name: newName, want } : { kind: 'domain', name: opened.name, seen: opened.draft, want };
  const problems = config ? draftProblems(edit, config) : [];
  // A missing field shows once Save is tried; a name another domain or a root entry has shows at once.
  const shown = tried ? problems : problems.filter((p) => p.kind === 'name-taken');
  const declared = problems.some((p) => p.kind === 'name-taken');
  const dirty = JSON.stringify([newName, want]) !== JSON.stringify(['', opened.draft]);
  const adopting = !declared && atRoot?.folder === true && atRoot.name === addedName(newName);
  const rootClash = atRoot && !declared && !adopting ? [copy.domains.refused.taken[atRoot.folder ? 'folder' : 'file'](atRoot.name)] : [];

  const disable = usePreventRemove(dirty && !done, ({ repeat }) => {
    Alert.alert(copy.domains.discardTitle, copy.domains.discardBody, [
      { text: copy.common.cancel, style: 'cancel' },
      {
        text: copy.domains.discard,
        style: 'destructive',
        onPress: () => {
          setDone(true);
          repeat();
        },
      },
    ]);
  });

  const setRow = (key: number, patch: Partial<TypeRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const addRow = () => {
    const key = nextKey.current++;
    setRows((rs) => [...rs, { key, kept: false, type: '', description: '', example: '' }]);
  };

  async function save() {
    setTried(true);
    if (problems.length || rootClash.length) return;
    setBusy(true);
    setError(null);
    const r = await editDomains(edit);
    setBusy(false);
    const text = editedText(r);
    if (text) return setError({ text, stale: r.kind === 'refused' && r.refusal.kind === 'moved-on' });
    setDone(true);
    disable();
    goBack();
  }

  return (
    <Screen>
      <Header title={opened.kind === 'new' ? copy.domains.newTitle : opened.name} back />
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={st.main} keyboardShouldPersistTaps="handled">
          {opened.kind === 'new' && (
            <Field label={copy.domains.name} hint={copy.domains.nameHint} problems={[...problemsAt(shown, 'name'), ...rootClash]}>
              <Input label={copy.domains.name} value={newName} onChangeText={setNewName} placeholder={copy.domains.namePlaceholder} editable={!busy} autoCapitalize="none" />
            </Field>
          )}

          <Field label={copy.domains.description} hint={copy.domains.descriptionHint} problems={problemsAt(shown, 'description')}>
            <Input label={copy.domains.description} value={description} onChangeText={setDescription} editable={!busy} />
          </Field>

          <View style={{ gap: 8 }}>
            <SectionTitle style={{ marginHorizontal: 4 }}>{copy.domains.pageTypes}</SectionTitle>
            <Text style={{ color: t.faint, fontSize: 12, lineHeight: 18, marginHorizontal: 4 }}>{copy.domains.pageTypesHint}</Text>
            {rows.map((r, i) => (
              <Card key={r.key} style={{ padding: 12, gap: 8 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  {r.kept ? (
                    <Text style={{ flex: 1, color: t.fg, fontSize: 15, fontWeight: '600' }}>{r.type}</Text>
                  ) : (
                    <Input label={copy.domains.typeName} value={r.type} onChangeText={(v) => setRow(r.key, { type: v })} placeholder={copy.domains.typeName} editable={!busy} autoCapitalize="none" style={{ flex: 1 }} />
                  )}
                  <Pressable accessibilityRole="button" accessibilityLabel={copy.domains.removeType(r.type)} disabled={busy} onPress={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} style={st.icon}>
                    <Icon name="trash" size={18} color={t.muted} />
                  </Pressable>
                </View>
                <Input label={copy.domains.typeDescription} value={r.description} onChangeText={(v) => setRow(r.key, { description: v })} placeholder={copy.domains.typeDescription} editable={!busy} />
                <Input label={copy.domains.typeExample} value={r.example} onChangeText={(v) => setRow(r.key, { example: v })} placeholder={copy.domains.typeExample} editable={!busy} autoCapitalize="none" />
                <Problems lines={problemsAt(shown, i)} />
              </Card>
            ))}
            <Problems lines={problemsAt(shown, 'types')} />
            <View style={{ alignItems: 'flex-start' }}>
              <SmallButton label={copy.domains.addType} icon="plus" disabled={busy} onPress={addRow} />
            </View>
          </View>

          {opened.kind === 'new' && (
            <Text style={{ color: t.faint, fontSize: 12, lineHeight: 18, marginHorizontal: 4 }}>{adopting ? copy.domains.adopt(atRoot.name) : copy.domains.newNote(addedName(newName))}</Text>
          )}

          {error && (
            <Notice tone="bad">
              <Text accessibilityRole="alert" style={{ color: t.bad, fontSize: 14, lineHeight: 21 }}>{error.text}</Text>
              {error.stale && (
                <View style={{ alignItems: 'flex-start' }}>
                  <SmallButton label={copy.domains.reload} onPress={onReload} />
                </View>
              )}
            </Notice>
          )}
          <PrimaryButton label={busy ? copy.common.saving : copy.common.save} busy={busy} disabled={!dirty} onPress={() => void save()} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/** The root entry a typed name would land on, looked up once typing pauses. */
function useRootEntry(name: string): RootEntry | null {
  const [entry, setEntry] = useState<RootEntry | null>(null);
  useEffect(() => {
    setEntry(null);
    if (!name) return;
    let live = true;
    const timer = setTimeout(() => void rootEntry(name).then((e) => live && setEntry(e)), 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [name]);
  return entry;
}

function Field({ label, hint, problems, children }: { label: string; hint: string; problems: readonly string[]; children: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: t.faint, fontSize: 12, fontWeight: '500', marginHorizontal: 4 }}>{label}</Text>
      {children}
      <Text style={{ color: t.faint, fontSize: 12, lineHeight: 18, marginHorizontal: 4 }}>{hint}</Text>
      <Problems lines={problems} />
    </View>
  );
}

function Problems({ lines }: { lines: readonly string[] }) {
  const t = useTheme();
  return lines.map((l) => (
    <Text key={l} style={{ color: t.bad, fontSize: 12, lineHeight: 18, marginHorizontal: 4 }}>
      {l}
    </Text>
  ));
}

function Input({ label, style, ...rest }: TextInputProps & { label: string }) {
  const t = useTheme();
  return <TextInput accessibilityLabel={label} placeholderTextColor={t.faint} {...rest} style={[st.input, { borderColor: t.line2, backgroundColor: t.bg, color: t.fg }, style]} />;
}

const st = StyleSheet.create({
  main: { padding: 16, gap: 20 },
  input: { height: 44, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, fontSize: 15 },
  icon: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
});
