import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type TextInputInstance } from 'react-native';
import type { MemoRow } from '../../jobs/engine';
import type { GeoFix } from '../../lib/capture';
import { locate } from '../../lib/location';
import { clock12, filedText, firstPage, recentTime, STAGE } from '../../lib/memos';
import { canSend } from '../../lib/photos';
import { filingStatus, statusLine } from '../../lib/status';
import { fileMemo, getApp, useApp } from '../../state';
import { DomainChips } from '../../ui/domain-chips';
import { useDraft } from '../../ui/draft';
import { useNow } from '../../ui/hooks';
import { Icon } from '../../ui/icon';
import { PhotoButtons, PhotoCount, PhotoStrip, usePhotoPicker } from '../../ui/photos';
import { Header, Notice, Pill, PrimaryButton, s as ui, Screen, SectionTitle } from '../../ui/parts';
import { useTheme } from '../../ui/theme';
import { copy } from '../../text';

type Fix = { kind: 'off' } | { kind: 'finding' } | { kind: 'found'; fix: GeoFix } | { kind: 'none' };

/** Location for the memo being written, fetched while typing so sending never waits for it. */
function useCompositionFix(): [Fix, () => void] {
  const enabled = useApp((a) => a.settings.location);
  const [fix, setFix] = useState<Fix>({ kind: enabled ? 'finding' : 'off' });
  const refresh = useCallback(() => {
    if (!getApp().settings.location) return setFix({ kind: 'off' });
    setFix((f) => (f.kind === 'found' ? f : { kind: 'finding' }));
    void locate().then((g) => setFix(g ? { kind: 'found', fix: g } : { kind: 'none' }));
  }, []);
  useEffect(refresh, [enabled, refresh]);
  return [fix, refresh];
}

/** Why memos are not being filed, or how many are on their way. Nothing when all is well. */
function FilingBadge({ now }: { now: Date }) {
  const t = useTheme();
  const login = useApp((a) => a.login);
  const folder = useApp((a) => a.folder?.state ?? null);
  const online = useApp((a) => a.online);
  const paused = useApp((a) => a.jobs.paused);
  const waiting = useApp((a) => a.book?.counts.working ?? 0);
  const line = statusLine(filingStatus({ login, folder, online, paused, waiting, now: now.getTime() }));
  if (!line) return null;
  const warn = line.tone === 'warn';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={line.text}
      disabled={!line.href}
      onPress={() => line.href && router.push(line.href as never)}
      style={[st.badge, { backgroundColor: warn ? t.bg3 : t.bg2 }]}
    >
      {warn ? <Icon name={online === false ? 'wifiOff' : 'alert'} size={14} color={t.warn} /> : <View style={[st.dot, { backgroundColor: t.okFg }]} />}
      <Text style={{ color: warn ? t.warn : t.muted, fontSize: 12 }}>{line.text}</Text>
    </Pressable>
  );
}

function RecentRow({ memo, now }: { memo: MemoRow; now: Date }) {
  const t = useTheme();
  const stage = STAGE[memo.at.state];
  const page = firstPage(memo);
  return (
    <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/memo/[id]', params: { id: memo.id } })} style={[st.item, { borderBottomColor: t.line }]}>
      <Text numberOfLines={2} style={{ color: t.fg, fontSize: 14, lineHeight: 21 }}>
        {memo.preview}
      </Text>
      <View style={st.meta}>
        <Text style={{ color: t.faint, fontSize: 12 }}>{recentTime(new Date(memo.capturedAt), now)}</Text>
        <Pill label={stage.label} tone={stage.tone} />
        <PhotoCount count={memo.photos} />
        {page ? (
          <View style={st.page}>
            <Icon name="file" size={12} color={t.link} />
            <Text numberOfLines={1} style={{ color: t.link, fontSize: 12, flexShrink: 1 }}>{page}</Text>
          </View>
        ) : 'domain' in memo.at ? (
          <Text numberOfLines={1} style={{ color: t.faint, fontSize: 12, flexShrink: 1 }}>{memo.at.domain}</Text>
        ) : null}
      </View>
    </Pressable>
  );
}

export default function MemoTab() {
  const t = useTheme();
  const input = useRef<TextInputInstance>(null);
  const draft = useDraft();
  const picker = usePhotoPicker(draft);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [attach, setAttach] = useState(true);
  const [fix, refreshFix] = useCompositionFix();
  const now = useNow();
  const rows = useApp((a) => a.book?.rows);
  const recent = useMemo(() => (rows ?? []).filter((m) => m.source !== 'feed').slice(0, 10), [rows]);

  useFocusEffect(
    useCallback(() => {
      const focus = setTimeout(() => input.current?.focus(), 250);
      refreshFix();
      return () => clearTimeout(focus);
    }, [refreshFix]),
  );

  async function send() {
    const text = draft.text.trim();
    if (!canSend(text, draft.photos) || sending || picker.busy) return;
    setSending(true);
    setNotice(null);
    const r = await fileMemo({ id: draft.id, text, source: 'typed', domainHint: draft.hint, location: attach && fix.kind === 'found' ? fix.fix : null, photos: draft.photos });
    setSending(false);
    if (r.kind === 'photo-refused') draft.refused(r);
    if (r.kind !== 'filed') return setNotice(filedText(r));
    draft.filed();
    setAttach(true);
  }

  return (
    <Screen>
      <Header
        title={copy.common.memo}
        mark
        right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <FilingBadge now={now} />
            <Pressable accessibilityRole="button" accessibilityLabel={copy.common.settings} onPress={() => router.push('/settings')} style={ui.iconButton}>
              <Icon name="settings" color={t.muted} />
            </Pressable>
          </View>
        }
      />
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={st.main} keyboardShouldPersistTaps="handled">
          <View style={[st.compose, { backgroundColor: t.bg2, borderColor: t.onLine }]}>
            <TextInput
              ref={input}
              accessibilityLabel={copy.memoTab.input}
              multiline
              editable={!sending}
              value={draft.text}
              onChangeText={draft.setText}
              placeholder={copy.memoTab.placeholder}
              placeholderTextColor={t.faint}
              style={[st.textarea, { color: t.fg }]}
              textAlignVertical="top"
            />
            <PhotoStrip picker={picker} disabled={sending} />
            <PhotoButtons picker={picker} disabled={sending} />
            <View style={st.composeMeta}>
              <View style={st.inline4}>
                <Icon name="clock" size={14} color={t.faint} />
                <Text style={{ color: t.faint, fontSize: 12 }}>{clock12(now)}</Text>
              </View>
              {fix.kind === 'none' && attach && (
                <Pressable accessibilityRole="button" accessibilityLabel={copy.memoTab.findLocationAgain} onPress={refreshFix} style={[st.loc, { borderColor: t.line2, borderStyle: 'dashed' }]}>
                  <Icon name="pin" size={14} color={t.faint} />
                  <Text style={{ color: t.faint, fontSize: 12 }}>{copy.memoTab.findLocationAgain}</Text>
                </Pressable>
              )}
              {fix.kind !== 'off' &&
                !(fix.kind === 'none' && attach) &&
                (attach ? (
                  <Pressable accessibilityRole="button" accessibilityLabel={copy.memoTab.removeLocation} onPress={() => setAttach(false)} style={[st.loc, { borderColor: t.line2 }]}>
                    <Icon name="pin" size={14} color={t.muted} />
                    <Text style={{ color: t.muted, fontSize: 12 }}>
                      {fix.kind === 'found' ? (fix.fix.place ?? copy.memoTab.here) : copy.memoTab.findingLocation}
                    </Text>
                    <Icon name="x" size={12} color={t.muted} strokeWidth={2} />
                  </Pressable>
                ) : (
                  <Pressable accessibilityRole="button" accessibilityLabel={copy.common.attachLocation} onPress={() => setAttach(true)} style={[st.loc, { borderColor: t.line2, borderStyle: 'dashed' }]}>
                    <Icon name="pin" size={14} color={t.faint} />
                    <Text style={{ color: t.faint, fontSize: 12 }}>{copy.common.attachLocation}</Text>
                  </Pressable>
                ))}
            </View>
          </View>

          <View style={{ gap: 8 }}>
            <SectionTitle>{copy.common.whereToFile}</SectionTitle>
            <DomainChips value={draft.hint} onChange={draft.setHint} />
          </View>

          <PrimaryButton label={copy.common.send} icon="send" busy={sending} disabled={!canSend(draft.text, draft.photos) || picker.busy} onPress={send} />
          {notice && (
            <Notice tone="bad">
              <Text accessibilityRole="alert" style={{ color: t.bad, fontSize: 14, lineHeight: 21 }}>{notice}</Text>
            </Notice>
          )}

          <View style={{ gap: 4 }}>
            <SectionTitle style={{ marginBottom: 4 }}>{copy.memoTab.recent}</SectionTitle>
            {recent.length === 0 ? (
              <View style={st.empty}>
                <Text style={{ color: t.muted, fontSize: 14 }}>{copy.memoTab.none}</Text>
                <Text style={{ color: t.faint, fontSize: 13, lineHeight: 21, textAlign: 'center' }}>
                  {copy.memoTab.noneHint}
                </Text>
              </View>
            ) : (
              recent.map((m) => <RecentRow key={m.id} memo={m} now={now} />)
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
      {picker.sheet}
    </Screen>
  );
}

const st = StyleSheet.create({
  main: { padding: 16, gap: 20 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 28, paddingHorizontal: 10, borderRadius: 14 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  compose: { padding: 16, borderRadius: 12, borderWidth: 1, gap: 12 },
  textarea: { minHeight: 154, fontSize: 16, lineHeight: 25.6, padding: 0 },
  composeMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  inline4: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  loc: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 28, paddingHorizontal: 8, borderRadius: 8, borderWidth: 1 },
  item: { paddingVertical: 12, gap: 8, borderBottomWidth: 1 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  page: { flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 },
  empty: { paddingVertical: 24, gap: 6, alignItems: 'center' },
});
