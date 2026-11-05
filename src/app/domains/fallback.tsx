import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { DomainName } from '../../core/types';
import { editedText } from '../../lib/domains';
import { editDomains, useWikiConfig } from '../../state';
import { goBack, Sheet } from '../../ui/parts';
import { useTheme } from '../../ui/theme';
import { copy } from '../../text';

/** Where a memo goes when the classifier cannot pick a domain. A tap saves it at once. */
export default function FallbackSheet() {
  const t = useTheme();
  const config = useWikiConfig();
  const [busy, setBusy] = useState<DomainName | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!config) {
    return (
      <Sheet onClose={goBack}>
        <Text style={{ color: t.muted, fontSize: 14, lineHeight: 21 }}>{copy.domains.notWiki}</Text>
      </Sheet>
    );
  }
  const seen = config.fallbackDomain;

  async function pick(d: DomainName) {
    if (d === seen) return goBack();
    setBusy(d);
    setError(null);
    const text = editedText(await editDomains({ kind: 'fallback', seen, want: d }));
    setBusy(null);
    if (text) return setError(text);
    goBack();
  }

  return (
    <Sheet onClose={goBack}>
      <View style={{ gap: 6 }}>
        <Text style={{ color: t.fg, fontSize: 17, fontWeight: '600' }}>{copy.domains.fallbackTitle}</Text>
        <Text style={{ color: t.muted, fontSize: 14, lineHeight: 21 }}>{copy.domains.fallbackNote}</Text>
      </View>

      <View accessibilityRole="radiogroup" style={{ gap: 8 }}>
        {[...config.domains.keys()].map((d) => {
          const on = d === seen;
          return (
            <Pressable
              key={d}
              accessibilityRole="radio"
              accessibilityLabel={d}
              accessibilityState={{ checked: on, disabled: busy !== null }}
              disabled={busy !== null}
              onPress={() => void pick(d)}
              style={[st.option, { backgroundColor: on ? t.onBg : 'transparent', borderColor: on ? t.onLine : t.line2 }]}
            >
              <View style={[st.radio, { borderColor: on ? t.onFg : t.line2, borderWidth: on ? 6 : 2 }]} />
              <Text style={{ flex: 1, color: t.fg, fontSize: 15, fontWeight: '500' }}>{d}</Text>
              {busy === d && <ActivityIndicator color={t.muted} size="small" />}
            </Pressable>
          );
        })}
      </View>

      {error && <Text accessibilityRole="alert" style={{ color: t.bad, fontSize: 13, lineHeight: 20 }}>{error}</Text>}
    </Sheet>
  );
}

const st = StyleSheet.create({
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1 },
  radio: { width: 20, height: 20, borderRadius: 10 },
});
