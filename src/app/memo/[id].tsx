import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { HOLD_BELOW } from '../../core/filing';
import type { FailedRow, MemoDetail } from '../../jobs/engine';
import { attemptsNote, failureSentence } from '../../lib/failure';
import { clock12, finishedText, monthDay, releasedText, verdictText } from '../../lib/memos';
import { confirmMemo, retryMemo, useMemoDetail } from '../../state';
import { useNow } from '../../ui/hooks';
import { Icon } from '../../ui/icon';
import { Card, FailureLine, Header, Notice, PrimaryButton, Screen, SectionTitle, SmallButton } from '../../ui/parts';
import { MemoThumbs } from '../../ui/photos';
import { openPage } from '../../ui/spans';
import { useTheme, type Theme } from '../../ui/theme';
import { copy } from '../../text';

type Node = 'done' | 'now' | 'bad';
type Step = { title: string; sub: string; node: Node };

function routingStep(m: MemoDetail): Step {
  if (m.at.state === 'inbox') return { title: copy.detail.waitingRoute, sub: copy.detail.waitingRouteSub, node: 'now' };
  const domain = m.at.domain;
  const r = m.routing;
  switch (r?.by) {
    case 'hint':
      return { title: copy.detail.filedTo(domain), sub: copy.detail.picked, node: 'done' };
    case 'user':
      return { title: copy.detail.movedTo(domain), sub: copy.detail.moved, node: 'done' };
    case 'fallback':
      return { title: copy.detail.parked(domain), sub: [copy.detail.couldNotRoute, r.reason].filter(Boolean).join(' · '), node: 'done' };
    case 'classifier':
      return {
        title: m.at.state === 'held' ? copy.detail.probably(domain) : copy.detail.filedTo(domain),
        sub: [copy.detail.sure(r.confidence >= HOLD_BELOW), r.reason].filter(Boolean).join(' · '),
        node: 'done',
      };
    default:
      return { title: copy.detail.filedTo(domain), sub: copy.common.auto, node: 'done' };
  }
}

function lastStep(m: MemoDetail, now: Date): Step | null {
  const at = m.at;
  switch (at.state) {
    case 'inbox':
      return null;
    case 'held':
      return { title: copy.detail.waitingConfirm, sub: copy.detail.waitingConfirmSub, node: 'now' };
    case 'routed':
      return { title: copy.stage.routed, sub: attemptsNote(at) ?? copy.detail.queuedSub, node: 'now' };
    case 'running':
      return { title: copy.stage.running, sub: attemptsNote(at) ?? copy.detail.runningSub, node: 'now' };
    case 'ingested':
      return { title: copy.stage.ingested, sub: `${finishedText(at.finished, now)} · ${verdictText(at.verdict)}`, node: 'done' };
    case 'failed':
      return { title: copy.detail.failed, sub: `${finishedText(at.finished, now)} · ${copy.failure.tried(at.failure.attempts)}`, node: 'bad' };
  }
}

function Timeline({ steps }: { steps: Step[] }) {
  const t = useTheme();
  return (
    <View>
      {steps.map((s, i) => (
        <View key={s.title} style={{ flexDirection: 'row', gap: 12 }}>
          <View style={{ width: 20, alignItems: 'center' }}>
            <View style={[st.node, nodeStyle(t, s.node)]} />
            {i < steps.length - 1 && <View style={[st.rail, { backgroundColor: t.line2 }]} />}
          </View>
          <View style={{ flex: 1, gap: 2, paddingBottom: 16 }}>
            <Text style={{ color: t.fg, fontSize: 14, fontWeight: '500' }}>{s.title}</Text>
            {s.sub ? <Text style={{ color: t.faint, fontSize: 12, lineHeight: 18 }}>{s.sub}</Text> : null}
          </View>
        </View>
      ))}
    </View>
  );
}

const nodeStyle = (t: Theme, n: Node) =>
  ({ done: { backgroundColor: t.okFg, borderColor: t.okFg }, now: { backgroundColor: t.bg, borderColor: t.onFg }, bad: { backgroundColor: t.bad, borderColor: t.bad } })[n];

function FailureNotice({ memo }: { memo: MemoDetail & { at: FailedRow['at'] } }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const f = memo.at.failure;
  async function retry() {
    setBusy(true);
    await retryMemo(memo.id, memo.at.domain);
    setBusy(false);
  }
  return (
    <Notice tone="bad">
      <FailureLine sentence={failureSentence(f)} note={attemptsNote(memo.at)} style={{ color: t.bad, fontSize: 14, lineHeight: 21 }} />
      {f.detail ? (
        <Pressable accessibilityRole="button" accessibilityLabel={open ? f.detail : copy.detail.more(f.detail)} onPress={() => setOpen((o) => !o)}>
          <Text style={{ color: t.faint, fontSize: 12, lineHeight: 18 }} numberOfLines={open ? undefined : 1}>
            {open ? f.detail : copy.detail.more(f.detail)}
          </Text>
        </Pressable>
      ) : null}
      <View style={{ flexDirection: 'row' }}>
        <SmallButton label={copy.common.retry} icon="retry" filled busy={busy} onPress={retry} />
      </View>
    </Notice>
  );
}

export default function MemoDetailScreen() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const shown = useMemoDetail(id);
  const now = useNow(60_000);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (shown.kind !== 'shown') {
    return (
      <Screen>
        <Header title={copy.common.memo} back />
        <Text style={{ color: t.muted, fontSize: 14, padding: 16 }}>{shown.kind === 'missing' ? copy.common.notFound : copy.common.loading}</Text>
      </Screen>
    );
  }
  const memo = shown.memo;
  const at = memo.at;
  const domain = at.state === 'inbox' ? null : at.domain;

  async function confirm() {
    setConfirming(true);
    setError(null);
    const r = await confirmMemo(memo.id);
    setConfirming(false);
    if (r.kind !== 'released') setError(releasedText(r, 'confirm'));
  }

  const captured = new Date(memo.capturedAt);
  const steps = [{ title: copy.stage.inbox, sub: clock12(captured), node: 'done' as const }, routingStep(memo), lastStep(memo, now)].filter((s): s is Step => s !== null);

  return (
    <Screen>
      <Header title={copy.common.memo} back />
      <ScrollView contentContainerStyle={st.main}>
        <View style={{ gap: 12 }}>
          {memo.text !== '' && <Text selectable style={{ color: t.fg, fontSize: 17, lineHeight: 27 }}>{memo.text}</Text>}
          <MemoThumbs files={memo.photos} />
          <View style={st.metaRow}>
            <Text style={st.meta(t)}>{`${monthDay(captured)} ${clock12(captured)}`}</Text>
            {memo.place && <Text style={st.meta(t)}>{memo.place}</Text>}
            <Text style={st.meta(t)}>{copy.source[memo.source]}</Text>
          </View>
        </View>

        <View style={{ gap: 12 }}>
          <SectionTitle>{copy.detail.progress}</SectionTitle>
          <Timeline steps={steps} />
        </View>

        {at.state === 'failed' && <FailureNotice memo={{ ...memo, at }} />}
        {error && (
          <Notice tone="bad">
            <Text style={{ color: t.bad, fontSize: 13, lineHeight: 20 }}>{error}</Text>
          </Notice>
        )}

        {at.state === 'ingested' && memo.pages.length > 0 && (
          <View style={{ gap: 8 }}>
            <SectionTitle>{copy.detail.pages}</SectionTitle>
            <Card>
              {memo.pages.map((p, i) => {
                const meta = [p.type, p.change === 'created' ? copy.detail.created : p.change === 'modified' ? copy.detail.modified : null].filter(Boolean).join(' · ');
                return (
                  <Pressable
                    key={p.path}
                    accessibilityRole="button"
                    accessibilityLabel={[p.path, meta].filter(Boolean).join(' ')}
                    onPress={() => openPage({ domain: at.domain, page: p.path })}
                    style={[st.page, i < memo.pages.length - 1 && { borderBottomWidth: 1, borderBottomColor: t.line }]}
                  >
                    <Icon name="file" size={16} color={t.faint} />
                    <Text style={{ flex: 1, color: t.link, fontSize: 14 }}>{p.path}</Text>
                    <Text style={{ color: t.faint, fontSize: 12 }}>{meta}</Text>
                  </Pressable>
                );
              })}
            </Card>
            <Text style={{ color: t.faint, fontSize: 12, lineHeight: 18, marginHorizontal: 4, marginTop: 4 }}>{copy.detail.rawKept(at.domain)}</Text>
          </View>
        )}

        {at.state === 'held' && <PrimaryButton label={copy.detail.confirm(at.domain)} busy={confirming} onPress={confirm} />}
        {(at.state === 'held' || at.state === 'failed') && domain && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copy.detail.moveElsewhere}
            onPress={() => router.push({ pathname: '/move/[id]', params: { id: memo.id, from: domain, text: memo.text } })}
            style={[st.outline, { borderColor: t.line2 }]}
          >
            <Text style={{ color: t.fg, fontSize: 15 }}>{copy.detail.moveElsewhere}</Text>
          </Pressable>
        )}
      </ScrollView>
    </Screen>
  );
}

const st = {
  ...StyleSheet.create({
    main: { paddingVertical: 20, paddingHorizontal: 16, gap: 28 },
    metaRow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 12, rowGap: 6 },
    node: { width: 10, height: 10, marginTop: 5, borderRadius: 5, borderWidth: 2 },
    rail: { flex: 1, width: 2, minHeight: 24, marginVertical: 4 },
    page: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 52, paddingHorizontal: 16 },
    outline: { height: 48, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  }),
  meta: (t: Theme) => ({ color: t.faint, fontSize: 12 }),
};
