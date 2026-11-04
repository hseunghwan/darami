import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import type { ChatSummary } from '../jobs/engine';
import { targetLabel } from '../lib/chats';
import { clock24, groupByDay } from '../lib/memos';
import { deleteChat, pastChats } from '../state';
import { useNow } from '../ui/hooks';
import { Icon } from '../ui/icon';
import { Header, Screen, SectionTitle } from '../ui/parts';
import { useTheme } from '../ui/theme';
import { copy } from '../text';

type Row = { kind: 'day'; label: string } | { kind: 'chat'; chat: ChatSummary };

function Entry({ chat, onDelete }: { chat: ChatSummary; onDelete: () => void }) {
  const t = useTheme();
  const time = clock24(new Date(chat.updatedAt));
  const turns = copy.chats.turns(chat.turns);
  return (
    <View style={[st.entry, { borderBottomColor: t.line }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[time, targetLabel(chat.target), '·', turns, chat.title].join(' ')}
        onPress={() => router.navigate({ pathname: '/chat', params: { open: chat.id } })}
        style={st.open}
      >
        <Text style={{ width: 48, color: t.faint, fontSize: 12, paddingTop: 2 }}>{time}</Text>
        <View style={{ flex: 1, gap: 6, minWidth: 0 }}>
          <View style={st.entryHead}>
            <Text style={{ color: t.muted, fontSize: 13 }}>{targetLabel(chat.target)}</Text>
            <Text style={{ color: t.faint, fontSize: 13 }}>·</Text>
            <Text style={{ color: t.faint, fontSize: 13 }}>{turns}</Text>
          </View>
          <Text numberOfLines={1} style={{ color: t.fg, fontSize: 14, lineHeight: 20 }}>{chat.title}</Text>
        </View>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={copy.chats.remove(chat.title)} onPress={onDelete} style={st.delete}>
        <Icon name="trash" size={16} color={t.faint} />
      </Pressable>
    </View>
  );
}

/** Every chat of the kept folder, newest first: one SQLite query, so no paging. */
export default function Chats() {
  const t = useTheme();
  const now = useNow(60_000);
  const [chats, setChats] = useState<readonly ChatSummary[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const list = await pastChats();
    if (!list) return setError(copy.chats.loadFailed);
    setError(null);
    setChats(list);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  function confirmDelete(chat: ChatSummary) {
    Alert.alert(copy.chats.confirmTitle, copy.chats.confirmBody, [
      { text: copy.common.cancel, style: 'cancel' },
      {
        text: copy.common.delete,
        style: 'destructive',
        onPress: async () => {
          if (await deleteChat(chat.id)) setChats((old) => old?.filter((c) => c.id !== chat.id) ?? null);
          else setError(copy.chats.removeFailed);
        },
      },
    ]);
  }

  const rows = useMemo<Row[]>(
    () => groupByDay(chats ?? [], now, (c) => c.updatedAt).flatMap((g) => [{ kind: 'day' as const, label: g.label }, ...g.items.map((chat) => ({ kind: 'chat' as const, chat }))]),
    [chats, now],
  );

  return (
    <Screen>
      <Header title={copy.chats.title} back />
      <FlatList
        data={rows}
        keyExtractor={(r) => (r.kind === 'day' ? `day:${r.label}` : r.chat.id)}
        contentContainerStyle={{ padding: 16 }}
        ListHeaderComponent={error ? <Text style={{ color: t.bad, fontSize: 13, marginBottom: 12 }}>{error}</Text> : undefined}
        renderItem={({ item, index }) =>
          item.kind === 'day' ? (
            <SectionTitle style={{ marginTop: index === 0 ? 0 : 24, marginBottom: 4 }}>{item.label}</SectionTitle>
          ) : (
            <Entry chat={item.chat} onDelete={() => confirmDelete(item.chat)} />
          )
        }
        ListEmptyComponent={chats ? <Text style={{ color: t.muted, fontSize: 14, textAlign: 'center', paddingVertical: 24 }}>{copy.chats.empty}</Text> : undefined}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await refresh();
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
  entry: { flexDirection: 'row', alignItems: 'flex-start', borderBottomWidth: 1 },
  open: { flex: 1, flexDirection: 'row', gap: 12, paddingVertical: 12 },
  entryHead: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  delete: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center', marginRight: -12 },
});
