import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { DomainName, MemoId } from '../../core/types';
import { releasedText } from '../../lib/memos';
import { moveMemo, useDomains } from '../../state';
import { goBack, PrimaryButton, Sheet } from '../../ui/parts';
import { useTheme } from '../../ui/theme';
import { copy } from '../../text';

export default function MoveSheet() {
  const t = useTheme();
  const { id, from, text } = useLocalSearchParams<{ id: string; from: string; text?: string }>();
  const domains = useDomains();
  const [picked, setPicked] = useState(from);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = useRef(true);
  useEffect(() => () => void (shown.current = false), []);

  async function go() {
    setBusy(true);
    setError(null);
    const r = await moveMemo(id as MemoId, picked as DomainName);
    setBusy(false);
    if (r.kind !== 'released') return setError(releasedText(r, 'move'));
    if (shown.current) goBack();
  }

  return (
    <Sheet onClose={goBack}>
      <View style={{ gap: 6 }}>
        <Text style={{ color: t.fg, fontSize: 17, fontWeight: '600' }}>{copy.move.title}</Text>
        {text ? (
          <Text numberOfLines={3} style={{ color: t.muted, fontSize: 14, lineHeight: 21 }}>
            {text}
          </Text>
        ) : null}
      </View>

      <View accessibilityRole="radiogroup" style={{ gap: 8 }}>
        {domains.map((d) => {
          const on = picked === d;
          return (
            <Pressable
              key={d}
              accessibilityRole="radio"
              accessibilityLabel={d}
              accessibilityState={{ checked: on }}
              onPress={() => setPicked(d)}
              style={[st.option, { backgroundColor: on ? t.onBg : 'transparent', borderColor: on ? t.onLine : t.line2 }]}
            >
              <View style={[st.radio, { borderColor: on ? t.onFg : t.line2, borderWidth: on ? 6 : 2 }]} />
              <Text style={{ flex: 1, color: t.fg, fontSize: 15, fontWeight: '500' }}>{d}</Text>
              {d === from && <Text style={{ color: t.faint, fontSize: 12 }}>{copy.move.current}</Text>}
            </Pressable>
          );
        })}
      </View>

      {error && <Text style={{ color: t.bad, fontSize: 13, lineHeight: 20 }}>{error}</Text>}
      <Text style={{ color: t.faint, fontSize: 12, lineHeight: 18 }}>{copy.move.restarts}</Text>
      <PrimaryButton label={copy.move.go} busy={busy} disabled={picked === from} onPress={go} />
    </Sheet>
  );
}

const st = StyleSheet.create({
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1 },
  radio: { width: 20, height: 20, borderRadius: 10 },
});
