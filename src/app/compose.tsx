import * as Crypto from 'expo-crypto';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { BackHandler, KeyboardAvoidingView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { GeoFix } from '../lib/capture';
import { removeQuietly } from '../lib/files';
import { locate } from '../lib/location';
import { memoText, parseShared, preview } from '../lib/shared';
import { fileMemo, getApp } from '../state';
import { DomainChips } from '../ui/domain-chips';
import { Icon } from '../ui/icon';
import { goBack, Notice, PrimaryButton, Sheet } from '../ui/parts';
import { useTheme } from '../ui/theme';
import { copy } from '../text';

/**
 * The share and text-selection sheet. It stays open, Save busy, until accept answers, and leaves
 * for the app the text came from only once the memo is whole in the folder. Photos come with P6.
 */
export default function Compose() {
  const t = useTheme();
  const params = useLocalSearchParams<{ source?: string; text?: string; subject?: string; photos?: string }>();
  const shared = parseShared(params);
  const [id] = useState(() => Crypto.randomUUID());
  const [note, setNote] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [fix, setFix] = useState<GeoFix | null>(null);

  useEffect(() => {
    if (getApp().settings.location) void locate().then(setFix);
  }, []);

  // CaptureActivity already copied shared photos into files/outbox/pending; nothing reads them until P6.
  const photos = shared?.photos ?? [];
  const photoKey = photos.join('\n');
  useEffect(() => removeQuietly(photoKey ? photoKey.split('\n') : []), [photoKey]);

  if (!shared) return <Sheet onClose={goBack}><Text style={{ color: t.muted, fontSize: 14 }}>{copy.compose.nothing}</Text></Sheet>;
  const card = shared.text ? preview(shared) : null;
  const text = memoText(shared, note);

  async function save() {
    if (!shared || !text.trim() || saving) return;
    setSaving(true);
    setNotice(null);
    const r = await fileMemo({ id, text, source: shared.source, domainHint: hint, location: fix });
    setSaving(false);
    if (r.kind === 'filed') return BackHandler.exitApp();
    setNotice(r.kind === 'no-wiki' ? copy.filing.noWiki : r.kind === 'invalid' ? copy.filing.invalid(r.detail) : copy.filing.notSaved);
  }

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
      <Sheet onClose={goBack}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ color: t.fg, fontSize: 17, fontWeight: '600' }}>{copy.compose.title}</Text>
        </View>
        {photos.length > 0 && (
          <Notice tone="plain">
            <Text style={{ color: t.muted, fontSize: 14, lineHeight: 21 }}>{text.trim() ? copy.compose.photosLater : copy.compose.onlyPhotos}</Text>
          </Notice>
        )}
        {card && (
          <View style={[st.card, { backgroundColor: t.bg, borderColor: t.cardLine }]}>
            <View style={[st.thumb, { backgroundColor: t.bubble }]}>
              <Icon name={card.kind === 'link' ? 'link' : 'quote'} size={18} color={t.onFg} />
            </View>
            <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
              {card.kind === 'link' ? (
                <>
                  <Text numberOfLines={1} style={{ color: t.fg, fontSize: 14 }}>{card.title}</Text>
                  <Text style={{ color: t.faint, fontSize: 12 }}>{card.host}</Text>
                </>
              ) : (
                <Text numberOfLines={3} style={{ color: t.fg, fontSize: 14, lineHeight: 21 }}>{card.text}</Text>
              )}
            </View>
          </View>
        )}

        <View style={{ gap: 6 }}>
          <Text style={{ color: t.faint, fontSize: 12, fontWeight: '500' }}>{copy.compose.note}</Text>
          <TextInput
            accessibilityLabel={copy.compose.noteLabel}
            value={note}
            onChangeText={setNote}
            placeholder={copy.compose.notePlaceholder}
            placeholderTextColor={t.faint}
            style={[st.input, { borderColor: t.line2, backgroundColor: t.bg, color: t.fg }]}
          />
        </View>

        <View style={{ gap: 8 }}>
          <Text style={{ color: t.faint, fontSize: 12, fontWeight: '500' }}>{copy.common.whereToFile}</Text>
          <DomainChips value={hint} onChange={setHint} wrap />
        </View>

        {notice && (
          <Notice tone="bad">
            <Text accessibilityRole="alert" style={{ color: t.bad, fontSize: 14, lineHeight: 21 }}>{notice}</Text>
          </Notice>
        )}
        <PrimaryButton label={saving ? copy.common.saving : copy.common.save} busy={saving} disabled={!text.trim()} onPress={save} />
      </Sheet>
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 10, borderWidth: 1 },
  thumb: { width: 40, height: 40, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  input: { height: 44, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, fontSize: 15 },
});
