import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { DEFAULT_MODEL, effortsFor, settleChoice, type ModelChoice } from '../../agent/model';
import type { Effort } from '../../codex/responses';
import { loadModels, pickModel, useApp } from '../../state';
import { goBack, QuietButton, Sheet, SmallButton } from '../../ui/parts';
import { useTheme } from '../../ui/theme';
import { copy } from '../../text';

function Option({ label, tag, on, onPress }: { label: string; tag?: string | null; on: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: on }}
      onPress={onPress}
      style={[st.option, { backgroundColor: on ? t.onBg : 'transparent', borderColor: on ? t.onLine : t.line2 }]}
    >
      <View style={[st.radio, { borderColor: on ? t.onFg : t.line2, borderWidth: on ? 6 : 2 }]} />
      <Text style={{ flex: 1, color: t.fg, fontSize: 15, fontWeight: '500' }}>{label}</Text>
      {tag ? <Text style={{ color: t.faint, fontSize: 12 }}>{tag}</Text> : null}
    </Pressable>
  );
}

/** Pick a model, then its effort. Default puts the role back on gpt-6-luna at the effort each job had. */
export default function ModelSheet() {
  const t = useTheme();
  const role: keyof ModelChoice = useLocalSearchParams<{ role: string }>().role === 'ask' ? 'ask' : 'filing';
  const choice = useApp((a) => a.models);
  const { list, fetch } = useApp((a) => a.modelList);
  const current = settleChoice(choice, list)[role];
  const [model, setModel] = useState<string | null>(null);

  useEffect(() => {
    void loadModels();
  }, []);

  const slugs = (list ?? []).map((m) => m.slug);
  if (current && !slugs.includes(current.model)) slugs.push(current.model);

  async function pick(effort: Effort | null) {
    await pickModel(role, model && effort ? { model, effort } : null);
    goBack();
  }

  if (model) {
    const listed = list?.find((m) => m.slug === model);
    return (
      <Sheet onClose={goBack}>
        <View style={{ gap: 6 }}>
          <Text style={{ color: t.fg, fontSize: 17, fontWeight: '600' }}>{copy.models.effortTitle(model)}</Text>
          <Text style={{ color: t.muted, fontSize: 14, lineHeight: 21 }}>{copy.models.effortNote}</Text>
        </View>
        <View accessibilityRole="radiogroup" style={{ gap: 8 }}>
          {effortsFor(listed).map((e) => (
            <Option key={e} label={e} tag={e === listed?.defaultEffort ? copy.models.modelDefault : null} on={current?.model === model && current.effort === e} onPress={() => void pick(e)} />
          ))}
        </View>
        <QuietButton label={copy.common.back} onPress={() => setModel(null)} />
      </Sheet>
    );
  }

  return (
    <Sheet onClose={goBack}>
      <Text style={{ color: t.fg, fontSize: 17, fontWeight: '600' }}>{role === 'filing' ? copy.models.filingTitle : copy.models.askTitle}</Text>
      <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ gap: 8 }}>
        <View accessibilityRole="radiogroup" style={{ gap: 8 }}>
          <Option label={copy.models.default(DEFAULT_MODEL)} on={current === null} onPress={() => void pick(null)} />
          {slugs.map((m) => (
            <Option key={m} label={m} tag={current?.model === m ? copy.models.inUse : null} on={current?.model === m} onPress={() => setModel(m)} />
          ))}
        </View>
      </ScrollView>
      {fetch === 'loading' && list === null && <Text style={{ color: t.faint, fontSize: 13 }}>{copy.models.loading}</Text>}
      {fetch === 'failed' && list !== null && <Text style={{ color: t.faint, fontSize: 12, lineHeight: 18 }}>{copy.models.stale}</Text>}
      {fetch === 'failed' && list === null && (
        <View style={{ gap: 8, alignItems: 'flex-start' }}>
          <Text style={{ color: t.warn, fontSize: 13, lineHeight: 20 }}>{copy.models.none}</Text>
          <SmallButton label={copy.common.retry} onPress={() => void loadModels()} />
        </View>
      )}
    </Sheet>
  );
}

const st = StyleSheet.create({
  option: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 56, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1 },
  radio: { width: 20, height: 20, borderRadius: 10 },
});
