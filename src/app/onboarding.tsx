import * as Clipboard from 'expo-clipboard';
import * as Location from 'expo-location';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { AuthFailure, DeviceCode } from '../codex/auth';
import { loginFailureText } from '../lib/login';
import { firstStep, nextStep, parseRepair, STEPS, type Step } from '../lib/onboarding';
import { startLogin, updateSettings, useApp } from '../state';
import { FolderStep } from '../ui/folder-step';
import { Icon } from '../ui/icon';
import { Card, Notice, PrimaryButton, QuietButton, Screen, SmallButton } from '../ui/parts';
import { useTheme } from '../ui/theme';
import { copy } from '../text';

export default function Onboarding() {
  const t = useTheme();
  const repair = parseRepair(useLocalSearchParams<{ repair?: string }>().repair);
  const login = useApp((a) => a.login);
  const [step, setStep] = useState<Step>(() => firstStep(repair, login));
  const location = useApp((a) => a.settings.location);

  function next() {
    const to = nextStep(step, repair);
    if (to) return setStep(to);
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }

  async function chooseLocation(allow: boolean) {
    const granted = allow && (await Location.requestForegroundPermissionsAsync()).granted;
    await updateSettings({ location: granted });
    next();
  }

  const index = STEPS.indexOf(step);
  return (
    <Screen>
      {!repair && (
        <View accessibilityLabel={copy.onboarding.steps(index + 1, STEPS.length)} style={st.steps}>
          {STEPS.map((s, i) => (
            <View key={s} style={[st.step, { backgroundColor: i <= index ? t.link : t.line2 }]} />
          ))}
        </View>
      )}
      {step === 'login' && <LoginStep repair={repair === 'login'} onDone={next} />}
      {step === 'folder' && <FolderStep repair={repair === 'folder'} onDone={next} />}
      {step === 'location' && <LocationStep onChoose={chooseLocation} />}
      {step === 'done' && <DoneStep location={location} />}
    </Screen>
  );
}

type Attempt =
  | { readonly kind: 'start' }
  | { readonly kind: 'asking' }
  | { readonly kind: 'code'; readonly code: DeviceCode; readonly cancel: () => void }
  | { readonly kind: 'failed'; readonly failure: AuthFailure };

/** A device code to type on the ChatGPT page, then the wait for approval. Leaving the step stops the wait. */
function LoginStep({ repair, onDone }: { repair: boolean; onDone: () => void }) {
  const t = useTheme();
  const login = useApp((a) => a.login);
  const [attempt, setAttempt] = useState<Attempt>({ kind: 'start' });
  const live = useRef<(() => void) | null>(null);
  useEffect(() => () => live.current?.(), []);

  async function begin() {
    setAttempt({ kind: 'asking' });
    const r = await startLogin();
    if (!r.ok) return setAttempt({ kind: 'failed', failure: r.failure });
    live.current = r.cancel;
    setAttempt({ kind: 'code', code: r.code, cancel: r.cancel });
    const end = await r.done;
    live.current = null;
    setAttempt(end.ok || end.failure.kind === 'cancelled' ? { kind: 'start' } : { kind: 'failed', failure: end.failure });
  }

  const loggedIn = login.kind === 'in' && attempt.kind !== 'code' && attempt.kind !== 'asking';
  const failure = attempt.kind === 'failed' ? loginFailureText(attempt.failure) : null;
  return (
    <ScrollView contentContainerStyle={st.main}>
      <View style={{ gap: 8 }}>
        <Text style={[st.title, { color: t.fg }]}>{repair ? copy.login.repairTitle : copy.login.title}</Text>
        <Text style={[st.lede, { color: t.muted }]}>{repair ? copy.login.repairLede : copy.login.lede}</Text>
      </View>

      {loggedIn && (
        <Notice tone="ok">
          <View accessibilityRole="text" style={st.row8}>
            <Icon name="checkCircle" size={18} color={t.okFg} />
            <Text style={{ flex: 1, color: t.okFg, fontSize: 14, fontWeight: '500' }}>{copy.login.loggedIn(login.email, login.plan)}</Text>
          </View>
        </Notice>
      )}

      {attempt.kind === 'code' && (
        <Card style={{ padding: 16, gap: 12 }}>
          <Text style={{ color: t.muted, fontSize: 14, lineHeight: 21 }}>{copy.login.typeCode}</Text>
          <Text selectable accessibilityLabel={attempt.code.userCode} style={{ color: t.fg, fontSize: 30, fontWeight: '700', letterSpacing: 3 }}>
            {attempt.code.userCode}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <SmallButton label={copy.login.copyCode} icon="copy" onPress={() => void Clipboard.setStringAsync(attempt.code.userCode)} />
            <SmallButton label={copy.login.openPage} icon="link" onPress={() => void Linking.openURL(attempt.code.verificationUrl)} />
          </View>
          <Text style={{ color: t.faint, fontSize: 13, lineHeight: 20 }}>{copy.login.waiting(new Date(attempt.code.expiresAt))}</Text>
        </Card>
      )}

      {failure && (
        <Notice tone="bad">
          <View accessibilityRole="alert" style={st.row8top}>
            <Icon name="alert" size={18} color={t.bad} />
            <Text style={{ flex: 1, color: t.bad, fontSize: 14, lineHeight: 21 }}>{failure}</Text>
          </View>
        </Notice>
      )}

      <Text style={{ color: t.faint, fontSize: 12, lineHeight: 18 }}>{copy.login.personalUse}</Text>
      <View style={{ flex: 1 }} />

      {loggedIn ? (
        <PrimaryButton tall label={repair ? copy.onboarding.done : copy.onboarding.next} onPress={onDone} />
      ) : attempt.kind === 'code' ? (
        <QuietButton label={copy.common.cancel} onPress={attempt.cancel} />
      ) : (
        <PrimaryButton
          tall
          label={attempt.kind === 'asking' ? copy.login.gettingCode : attempt.kind === 'failed' ? copy.login.newCode : copy.login.getCode}
          busy={attempt.kind === 'asking'}
          onPress={() => void begin()}
        />
      )}
    </ScrollView>
  );
}

function LocationStep({ onChoose }: { onChoose: (allow: boolean) => void }) {
  const t = useTheme();
  return (
    <View style={st.main}>
      <View style={[st.badge, { backgroundColor: t.onBg }]}>
        <Icon name="pin" size={26} color={t.onFg} />
      </View>
      <View style={{ gap: 8 }}>
        <Text style={[st.title, { color: t.fg }]}>{copy.onboarding.locationTitle}</Text>
        <Text style={[st.lede, { color: t.muted }]}>{copy.onboarding.locationLede}</Text>
      </View>
      <View style={{ gap: 12 }}>
        {copy.onboarding.locationPoints.map((p) => (
          <View key={p} style={{ flexDirection: 'row', gap: 10 }}>
            <Icon name="check" size={18} color={t.okFg} />
            <Text style={{ flex: 1, color: t.muted, fontSize: 14, lineHeight: 21 }}>{p}</Text>
          </View>
        ))}
      </View>
      <View style={{ flex: 1 }} />
      <View style={{ gap: 8 }}>
        <PrimaryButton tall label={copy.onboarding.allowLocation} onPress={() => onChoose(true)} />
        <QuietButton label={copy.onboarding.later} onPress={() => onChoose(false)} />
      </View>
    </View>
  );
}

function DoneStep({ location }: { location: boolean }) {
  const t = useTheme();
  const folder = useApp((a) => a.folder);
  const login = useApp((a) => a.login);
  return (
    <View style={st.main}>
      <View style={[st.badge, { backgroundColor: t.okBg }]}>
        <Icon name="check" size={26} color={t.okFg} />
      </View>
      <View style={{ gap: 8 }}>
        <Text style={[st.title, { color: t.fg }]}>{copy.onboarding.readyTitle}</Text>
        <Text style={[st.lede, { color: t.muted }]}>{copy.onboarding.readyLede}</Text>
      </View>
      <Card>
        <View style={[st.kv, { borderBottomWidth: 1, borderBottomColor: t.line }]}>
          <Text style={{ color: t.muted, fontSize: 14 }}>{copy.folder.label}</Text>
          <Text numberOfLines={1} style={{ flexShrink: 1, color: t.fg, fontSize: 14 }}>{folder?.tree.name ?? copy.folder.none}</Text>
        </View>
        <View style={[st.kv, { borderBottomWidth: 1, borderBottomColor: t.line }]}>
          <Text style={{ color: t.muted, fontSize: 14 }}>{copy.onboarding.account}</Text>
          <Text numberOfLines={1} style={{ flexShrink: 1, color: login.kind === 'in' ? t.okFg : t.warn, fontSize: 14 }}>
            {login.kind === 'in' ? (login.email ?? copy.settings.loggedIn) : copy.settings.notLoggedIn}
          </Text>
        </View>
        <View style={st.kv}>
          <Text style={{ color: t.muted, fontSize: 14 }}>{copy.common.attachLocation}</Text>
          <Text style={{ color: t.fg, fontSize: 14 }}>{location ? copy.onboarding.on : copy.onboarding.off}</Text>
        </View>
      </Card>
      <Text style={{ color: t.faint, fontSize: 13, lineHeight: 21 }}>{copy.onboarding.shareHint}</Text>
      <View style={{ flex: 1 }} />
      <PrimaryButton tall label={copy.onboarding.firstMemo} onPress={() => router.replace('/')} />
    </View>
  );
}

const st = StyleSheet.create({
  steps: { flexDirection: 'row', gap: 6, paddingTop: 24, paddingHorizontal: 24 },
  step: { flex: 1, height: 4, borderRadius: 2 },
  main: { flexGrow: 1, paddingTop: 40, paddingHorizontal: 24, paddingBottom: 24, gap: 24 },
  title: { fontSize: 24, fontWeight: '600', letterSpacing: -0.48 },
  lede: { fontSize: 15, lineHeight: 24 },
  row8: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  row8top: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  badge: { width: 56, height: 56, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  kv: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 52, paddingHorizontal: 16 },
});
