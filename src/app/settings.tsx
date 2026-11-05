import Constants from 'expo-constants';
import * as Location from 'expo-location';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, type ReactNode } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { DEFAULT_MODEL, settleChoice, type ModelChoice } from '../agent/model';
import { filingStatus, statusLine } from '../lib/status';
import { fileNow, loadModels, logOut, recheckFolder, updateSettings, useApp, type Folder, type ThemePref } from '../state';
import { useNow } from '../ui/hooks';
import { Card, Header, Screen, SectionTitle, SmallButton } from '../ui/parts';
import { useTheme } from '../ui/theme';
import { copy } from '../text';

const THEMES: { pref: ThemePref; label: string }[] = [
  { pref: 'system', label: copy.settings.theme.system },
  { pref: 'dark', label: copy.settings.theme.dark },
  { pref: 'light', label: copy.settings.theme.light },
];

function Row({ label, children, last, style }: { label: string; children?: ReactNode; last?: boolean; style?: object }) {
  const t = useTheme();
  return (
    <View style={[st.row, !last && { borderBottomWidth: 1, borderBottomColor: t.line }, style]}>
      <Text style={{ color: t.fg, fontSize: 14 }}>{label}</Text>
      {children}
    </View>
  );
}

function folderStatus(folder: Folder): string {
  const s = folder.state;
  if (s === null) return copy.folder.status.checking;
  switch (s.kind) {
    case 'wiki':
      return copy.folder.status.wiki(s.config.domains.size);
    case 'broken':
      return copy.folder.status.broken;
    case 'unreachable':
      return copy.folder.status.unreachable;
    default:
      return copy.folder.status.notWiki;
  }
}

function Switch({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: on }}
      onPress={onToggle}
      style={[st.switch, { backgroundColor: on ? t.btn : t.seg, justifyContent: on ? 'flex-end' : 'flex-start' }]}
    >
      <View style={[st.knob, { backgroundColor: t.knob }]} />
    </Pressable>
  );
}

function ChatGptSection() {
  const t = useTheme();
  const login = useApp((a) => a.login);
  const account = login.kind === 'in' ? [login.email, login.plan].filter(Boolean).join(' · ') || copy.settings.loggedIn : login.kind === 'expired' ? copy.settings.loginExpired(login.email) : copy.settings.notLoggedIn;
  function confirmLogOut() {
    Alert.alert(copy.settings.logOutTitle, copy.settings.logOutBody, [
      { text: copy.common.cancel, style: 'cancel' },
      { text: copy.settings.logOut, style: 'destructive', onPress: () => void logOut() },
    ]);
  }
  return (
    <View style={st.section}>
      <SectionTitle style={st.h2}>{copy.settings.account}</SectionTitle>
      <Card>
        <Row label={copy.settings.accountRow}>
          <Text numberOfLines={1} style={{ flexShrink: 1, color: login.kind === 'in' ? t.muted : t.warn, fontSize: 14 }}>{account}</Text>
        </Row>
        {login.kind === 'in' ? (
          <Pressable accessibilityRole="button" accessibilityLabel={copy.settings.logOut} onPress={confirmLogOut} style={st.action}>
            <Text style={{ color: t.link, fontSize: 14 }}>{copy.settings.logOut}</Text>
          </Pressable>
        ) : (
          <Pressable accessibilityRole="button" accessibilityLabel={copy.settings.logInAgain} onPress={() => router.push({ pathname: '/onboarding', params: { repair: 'login' } })} style={st.action}>
            <Text style={{ color: t.link, fontSize: 14 }}>{copy.settings.logInAgain}</Text>
          </Pressable>
        )}
      </Card>
      <Text style={{ color: t.faint, fontSize: 12, lineHeight: 18, marginHorizontal: 4 }}>{copy.login.personalUse}</Text>
    </View>
  );
}

function ModelSection() {
  const t = useTheme();
  const choice = useApp((a) => a.models);
  const list = useApp((a) => a.modelList.list);
  const inUse = settleChoice(choice, list);
  const roles: { role: keyof ModelChoice; label: string }[] = [
    { role: 'filing', label: copy.models.filing },
    { role: 'ask', label: copy.models.ask },
  ];
  return (
    <View style={st.section}>
      <SectionTitle style={st.h2}>{copy.models.title}</SectionTitle>
      <Card>
        {roles.map(({ role, label }, i) => {
          const pick = inUse[role];
          const value = pick ? copy.models.picked(pick.model, pick.effort) : copy.models.default(DEFAULT_MODEL);
          return (
            <Pressable
              key={role}
              accessibilityRole="button"
              accessibilityLabel={label}
              accessibilityValue={{ text: value }}
              onPress={() => router.push({ pathname: '/model/[role]', params: { role } })}
            >
              <Row label={label} last={i === roles.length - 1}>
                <Text numberOfLines={1} style={{ flexShrink: 1, color: t.muted, fontSize: 14 }}>{value}</Text>
              </Row>
            </Pressable>
          );
        })}
      </Card>
      <Text style={{ color: t.faint, fontSize: 12, lineHeight: 18, marginHorizontal: 4 }}>{copy.models.note}</Text>
    </View>
  );
}

function FilingSection() {
  const t = useTheme();
  const now = useNow();
  const login = useApp((a) => a.login);
  const folder = useApp((a) => a.folder?.state ?? null);
  const online = useApp((a) => a.online);
  const paused = useApp((a) => a.jobs.paused);
  const waiting = useApp((a) => a.book?.counts.working ?? 0);
  const line = statusLine(filingStatus({ login, folder, online, paused, waiting, now: now.getTime() }));
  return (
    <View style={st.section}>
      <SectionTitle style={st.h2}>{copy.settings.filing}</SectionTitle>
      <Card>
        <View style={[st.row, { minHeight: 60, paddingVertical: 8, paddingRight: 8 }]}>
          <View style={{ gap: 2, flexShrink: 1 }}>
            <Text style={{ color: t.fg, fontSize: 14 }}>{waiting > 0 ? copy.settings.waiting(waiting) : copy.settings.upToDate}</Text>
            {line && <Text style={{ color: line.tone === 'warn' ? t.warn : t.faint, fontSize: 12 }}>{line.text}</Text>}
          </View>
          <SmallButton label={copy.settings.fileNow} disabled={waiting === 0} onPress={() => void fileNow()} />
        </View>
      </Card>
    </View>
  );
}

export default function Settings() {
  const t = useTheme();
  const settings = useApp((a) => a.settings);
  const folder = useApp((a) => a.folder);

  // A fix made in Obsidian or a file manager shows when the user comes back here.
  useFocusEffect(
    useCallback(() => {
      void recheckFolder();
      void loadModels();
    }, []),
  );

  async function toggleLocation() {
    if (settings.location) return updateSettings({ location: false });
    const { granted } = await Location.requestForegroundPermissionsAsync();
    await updateSettings({ location: granted });
  }

  return (
    <Screen>
      <Header title={copy.common.settings} back />
      <ScrollView contentContainerStyle={st.main}>
        <View style={st.section}>
          <SectionTitle style={st.h2}>{copy.folder.label}</SectionTitle>
          <Card>
            <Row label={copy.folder.name}>
              <Text numberOfLines={1} style={{ flexShrink: 1, color: t.muted, fontSize: 14 }}>{folder?.tree.name ?? copy.folder.none}</Text>
            </Row>
            {folder && (
              <Row label={copy.settings.status}>
                <Text style={{ flexShrink: 1, color: folder.state && folder.state.kind !== 'wiki' ? t.warn : t.muted, fontSize: 14 }}>{folderStatus(folder)}</Text>
              </Row>
            )}
            {folder?.state?.kind === 'wiki' && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={copy.domains.change}
                onPress={() => router.push('/domains')}
                style={[st.action, { borderBottomWidth: 1, borderBottomColor: t.line }]}
              >
                <Text style={{ color: t.link, fontSize: 14 }}>{copy.domains.change}</Text>
              </Pressable>
            )}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={copy.folder.change}
              onPress={() => router.push({ pathname: '/onboarding', params: { repair: 'folder' } })}
              style={st.action}
            >
              <Text style={{ color: t.link, fontSize: 14 }}>{copy.folder.change}</Text>
            </Pressable>
          </Card>
        </View>

        <ChatGptSection />

        <ModelSection />

        <View style={st.section}>
          <SectionTitle style={st.h2}>{copy.common.memo}</SectionTitle>
          <Card>
            <View style={[st.row, { minHeight: 60, paddingVertical: 8 }]}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={{ color: t.fg, fontSize: 14 }}>{copy.common.attachLocation}</Text>
                <Text style={{ color: t.faint, fontSize: 12 }}>{copy.settings.locationNote}</Text>
              </View>
              <Switch label={copy.common.attachLocation} on={settings.location} onToggle={toggleLocation} />
            </View>
          </Card>
        </View>

        <View style={st.section}>
          <SectionTitle style={st.h2}>{copy.settings.display}</SectionTitle>
          <Card style={{ padding: 16, gap: 12 }}>
            <Text style={{ color: t.fg, fontSize: 14 }}>{copy.settings.themeLabel}</Text>
            <View accessibilityRole="radiogroup" style={[st.segs, { backgroundColor: t.seg }]}>
              {THEMES.map(({ pref, label }) => {
                const on = settings.theme === pref;
                return (
                  <Pressable
                    key={pref}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    onPress={() => updateSettings({ theme: pref })}
                    style={[st.seg, on && { backgroundColor: t.bg, elevation: 1 }]}
                  >
                    <Text style={{ color: on ? t.fg : t.muted, fontSize: 13, fontWeight: '500' }}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </Card>
        </View>

        <FilingSection />

        <View style={st.section}>
          <SectionTitle style={st.h2}>{copy.settings.about}</SectionTitle>
          <Card>
            <Row label={copy.settings.appVersion} last>
              <Text style={{ color: t.muted, fontSize: 14 }}>{Constants.expoConfig?.version ?? '-'}</Text>
            </Row>
          </Card>
        </View>
      </ScrollView>
    </Screen>
  );
}

const st = StyleSheet.create({
  main: { padding: 16, gap: 24 },
  section: { gap: 8 },
  h2: { marginHorizontal: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, minHeight: 52, paddingHorizontal: 16 },
  action: { minHeight: 52, paddingHorizontal: 16, justifyContent: 'center' },
  switch: { width: 52, height: 32, borderRadius: 16, padding: 3, flexDirection: 'row', alignItems: 'center' },
  knob: { width: 26, height: 26, borderRadius: 13, elevation: 2 },
  segs: { flexDirection: 'row', gap: 4, padding: 4, borderRadius: 10 },
  seg: { flex: 1, height: 36, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
});
