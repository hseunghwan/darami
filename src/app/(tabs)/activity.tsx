import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import type { FailedRow, HeldRow, MemoRow } from '../../jobs/engine';
import { attemptsNote, failureSentence } from '../../lib/failure';
import { clock24, firstPage, groupByDay, releasedText, STAGE, verdictText } from '../../lib/memos';
import { confirmMemo, refreshMemos, retryMemo, useApp } from '../../state';
import { useNow } from '../../ui/hooks';
import { Icon } from '../../ui/icon';
import { Card, FailureLine, Header, Notice, s as ui, Screen, SectionTitle, SmallButton } from '../../ui/parts';
import { useTheme } from '../../ui/theme';
import { copy } from '../../text';

type Row = { kind: 'day'; label: string } | { kind: 'memo'; memo: MemoRow };

function heldLine(h: HeldRow): string {
  return h.routing?.by === 'classifier' ? copy.activity.heldGuess(h.at.domain, h.routing.reason.trim()) : copy.activity.heldFallback(h.at.domain);
}

function HeldCard({ held }: { held: HeldRow }) {
  const t = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function confirm() {
    setBusy(true);
    setError(null);
    const r = await confirmMemo(held.id);
    setBusy(false);
    // A released card leaves by itself: the book saw the hold file go.
    if (r.kind !== 'released') setError(releasedText(r, 'confirm'));
  }
  return (
    <Card style={st.cardBody}>
      <View style={st.inline6}>
        <Icon name="alert" size={14} color={t.warn} />
        <Text style={{ color: t.warn, fontSize: 12 }}>{copy.activity.unsure}</Text>
      </View>
      <Text style={{ color: t.fg, fontSize: 14, lineHeight: 21 }}>{held.preview}</Text>
      <Text numberOfLines={3} style={{ color: t.muted, fontSize: 13, lineHeight: 19 }}>{heldLine(held)}</Text>
      {error && <Text style={{ color: t.bad, fontSize: 12 }}>{error}</Text>}
      <View style={st.buttons}>
        <SmallButton label={copy.activity.yes} busy={busy} onPress={confirm} />
        <SmallButton
          label={copy.activity.elsewhere}
          color={t.muted}
          onPress={() => router.push({ pathname: '/move/[id]', params: { id: held.id, from: held.at.domain, text: held.preview } })}
        />
      </View>
    </Card>
  );
}

function FailedCard({ memo }: { memo: FailedRow }) {
  const t = useTheme();
  const [busy, setBusy] = useState(false);
  async function retry() {
    setBusy(true);
    await retryMemo(memo.id, memo.at.domain);
    setBusy(false);
  }
  return (
    <Card style={st.cardBody}>
      <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/memo/[id]', params: { id: memo.id } })} style={{ gap: 10 }}>
        <View style={st.inline6}>
          <Icon name="x" size={14} color={t.bad} />
          <Text style={{ color: t.bad, fontSize: 12 }}>{`${copy.activity.failedLine} · ${copy.failure.tried(memo.at.failure.attempts)}`}</Text>
        </View>
        <Text numberOfLines={3} style={{ color: t.fg, fontSize: 14, lineHeight: 21 }}>{memo.preview}</Text>
        <FailureLine sentence={failureSentence(memo.at.failure)} note={attemptsNote(memo.at)} style={{ color: t.muted, fontSize: 13, lineHeight: 19 }} />
      </Pressable>
      <View style={st.buttons}>
        <SmallButton label={copy.common.retry} icon="retry" filled busy={busy} onPress={retry} />
      </View>
    </Card>
  );
}

function Entry({ memo }: { memo: MemoRow }) {
  const t = useTheme();
  const what = memo.at.state === 'ingested' ? verdictText(memo.at.verdict) : STAGE[memo.at.state].label;
  const page = firstPage(memo);
  return (
    <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/memo/[id]', params: { id: memo.id } })} style={[st.entry, { borderBottomColor: t.line }]}>
      <Text style={{ width: 48, color: t.faint, fontSize: 12, paddingTop: 2 }}>{clock24(new Date(memo.capturedAt))}</Text>
      <View style={{ flex: 1, gap: 6, minWidth: 0 }}>
        <View style={st.entryHead}>
          <Text style={{ color: t.muted, fontSize: 13 }}>{'domain' in memo.at ? memo.at.domain : copy.activity.unrouted}</Text>
          <Text style={{ color: t.faint, fontSize: 13 }}>·</Text>
          <Text style={{ color: memo.at.state === 'failed' ? t.bad : t.fg, fontSize: 13 }}>{what}</Text>
          {page && <Text style={{ color: t.link, fontSize: 13 }}>{page}</Text>}
        </View>
        <Text numberOfLines={1} style={{ color: t.faint, fontSize: 13, lineHeight: 19 }}>{memo.preview.replace(/\s+/g, ' ')}</Text>
      </View>
    </Pressable>
  );
}

/** While the login is the reason memos wait: a background event never takes the user off a screen, so the way back is offered here. */
function LoginLost() {
  const t = useTheme();
  const lost = useApp((a) => a.login.kind !== 'in' || a.jobs.paused?.cause === 'login');
  if (!lost) return null;
  return (
    <View style={{ marginBottom: 16 }}>
      <Notice tone="bad">
        <Text style={{ color: t.bad, fontSize: 14, lineHeight: 21 }}>{copy.activity.loginLost}</Text>
        <View style={{ flexDirection: 'row' }}>
          <SmallButton label={copy.login.repairTitle} onPress={() => router.push({ pathname: '/onboarding', params: { repair: 'login' } })} />
        </View>
      </Notice>
    </View>
  );
}

export default function Activity() {
  const t = useTheme();
  const book = useApp((a) => a.book);
  const now = useNow(60_000);
  const [refreshing, setRefreshing] = useState(false);

  const rows = useMemo<Row[]>(
    () => groupByDay(book?.rows ?? [], now, (m) => m.capturedAt).flatMap((g) => [{ kind: 'day' as const, label: g.label }, ...g.items.map((memo) => ({ kind: 'memo' as const, memo }))]),
    [book?.rows, now],
  );

  const header = (
    <>
      <LoginLost />
      {book && book.held.length + book.failed.length > 0 && (
        <View style={{ gap: 8, marginBottom: 24 }}>
          <SectionTitle>{copy.activity.needsYou}</SectionTitle>
          {book.held.map((h) => (
            <HeldCard key={h.id} held={h} />
          ))}
          {book.failed.map((f) => (
            <FailedCard key={f.id} memo={f} />
          ))}
        </View>
      )}
    </>
  );

  return (
    <Screen>
      <Header title={copy.activity.title} mark right={book && <Text style={{ color: t.faint, fontSize: 12 }}>{copy.activity.counts(book.counts.working, book.counts.confirm)}</Text>} />
      <FlatList
        data={rows}
        keyExtractor={(r) => (r.kind === 'day' ? `day:${r.label}` : r.memo.id)}
        contentContainerStyle={{ padding: 16 }}
        ListHeaderComponent={header}
        renderItem={({ item, index }) =>
          item.kind === 'day' ? <SectionTitle style={{ marginTop: index === 0 ? 0 : 24, marginBottom: 4 }}>{item.label}</SectionTitle> : <Entry memo={item.memo} />
        }
        ListFooterComponent={book && book.reading > 0 ? <Text style={[ui.h2, { color: t.faint, textAlign: 'center', padding: 16 }]}>{copy.activity.reading(book.reading)}</Text> : undefined}
        ListEmptyComponent={<Text style={{ color: t.muted, fontSize: 14, textAlign: 'center', paddingVertical: 24 }}>{book?.ready ? copy.activity.empty : copy.activity.opening}</Text>}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await refreshMemos();
              setRefreshing(false);
            }}
            tintColor={t.muted}
            colors={[t.btn]}
            progressBackgroundColor={t.bg2}
          />
        }
      />
    </Screen>
  );
}

const st = StyleSheet.create({
  cardBody: { padding: 14, gap: 10 },
  inline6: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  buttons: { flexDirection: 'row', gap: 8 },
  entry: { flexDirection: 'row', gap: 12, paddingVertical: 12, borderBottomWidth: 1 },
  entryHead: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
});
