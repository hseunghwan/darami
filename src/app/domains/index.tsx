import { router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { recheckFolder, useWikiConfig } from '../../state';
import { Icon } from '../../ui/icon';
import { Card, Header, Notice, Screen, SmallButton } from '../../ui/parts';
import { useTheme } from '../../ui/theme';
import { copy } from '../../text';

/** The wiki's domains: open one to change it, pick where unsure memos go, or add one. */
export default function Domains() {
  const t = useTheme();
  const config = useWikiConfig();

  // A change made in Obsidian or a file manager shows when the user comes back here.
  useFocusEffect(
    useCallback(() => {
      void recheckFolder();
    }, []),
  );

  return (
    <Screen>
      <Header title={copy.domains.title} back />
      <ScrollView contentContainerStyle={st.main}>
        {!config ? (
          <Notice tone="plain">
            <Text style={{ color: t.muted, fontSize: 14, lineHeight: 21 }}>{copy.domains.notWiki}</Text>
          </Notice>
        ) : (
          <>
            <Card>
              {[...config.domains.values()].map((d, i, all) => (
                <Pressable
                  key={d.name}
                  accessibilityRole="button"
                  accessibilityLabel={d.name}
                  accessibilityHint={d.description}
                  onPress={() => router.push({ pathname: '/domains/edit', params: { name: d.name } })}
                  style={[st.row, i < all.length - 1 && { borderBottomWidth: 1, borderBottomColor: t.line }]}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={{ color: t.fg, fontSize: 15, fontWeight: '500' }}>{d.name}</Text>
                    <Text numberOfLines={2} style={{ color: t.faint, fontSize: 13, lineHeight: 19 }}>{d.description}</Text>
                  </View>
                  <Icon name="chevronRight" size={18} color={t.faint} />
                </Pressable>
              ))}
            </Card>
            <Card>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={copy.domains.fallback}
                accessibilityValue={{ text: config.fallbackDomain }}
                onPress={() => router.push('/domains/fallback')}
                style={st.row}
              >
                <Text style={{ color: t.fg, fontSize: 14 }}>{copy.domains.fallback}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 1 }}>
                  <Text numberOfLines={1} style={{ flexShrink: 1, color: t.muted, fontSize: 14 }}>{config.fallbackDomain}</Text>
                  <Icon name="chevronRight" size={18} color={t.faint} />
                </View>
              </Pressable>
            </Card>
            <View style={{ alignItems: 'flex-start' }}>
              <SmallButton label={copy.domains.add} icon="plus" onPress={() => router.push('/domains/edit')} />
            </View>
            <Text style={{ color: t.faint, fontSize: 12, lineHeight: 18, marginHorizontal: 4 }}>{copy.domains.outside}</Text>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const st = StyleSheet.create({
  main: { padding: 16, gap: 16 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, minHeight: 52, paddingVertical: 10, paddingHorizontal: 16 },
});
