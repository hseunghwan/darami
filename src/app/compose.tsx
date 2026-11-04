import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { BackHandler, KeyboardAvoidingView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { GeoFix } from '../lib/capture';
import { removeQuietly } from '../lib/files';
import { locate } from '../lib/location';
import { filedText } from '../lib/memos';
import { canSend } from '../lib/photos';
import { memoText, parseShared, preview } from '../lib/shared';
import { fromShare } from '../pick';
import { fileMemo, getApp } from '../state';
import { DomainChips } from '../ui/domain-chips';
import { useDraft } from '../ui/draft';
import { Icon } from '../ui/icon';
import { goBack, Notice, PrimaryButton, Sheet } from '../ui/parts';
import { PhotoStrip, usePhotoPicker } from '../ui/photos';
import { useTheme } from '../ui/theme';
import { copy } from '../text';

/**
 * The share and text-selection sheet. It stays open, Save busy, until accept answers, and leaves
 * for the app the text came from only once the memo is whole in the folder. Shared photos are the
 * files CaptureActivity copied; closing the sheet without saving deletes them.
 */
export default function Compose() {
  const t = useTheme();
  const params = useLocalSearchParams<{ source?: string; text?: string; subject?: string; photos?: string }>();
  const shared = parseShared(params);
  const draft = useDraft(false);
  const picker = usePhotoPicker(draft);
  const [importing, setImporting] = useState((shared?.photos.length ?? 0) > 0);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [fix, setFix] = useState<GeoFix | null>(null);

  useEffect(() => {
    if (getApp().settings.location) void locate().then(setFix);
  }, []);

  const photoKey = shared?.photos.join('\n') ?? '';
  useEffect(() => {
    if (!photoKey) return;
    void fromShare(photoKey.split('\n')).then((ps) => {
      draft.addPhotos(ps);
      setImporting(false);
    });
    // Once per share: the draft's own functions change on every render.
  }, [photoKey]);

  const close = () => {
    removeQuietly(shared?.photos ?? []);
    goBack();
  };

  if (!shared) return <Sheet onClose={goBack}><Text style={{ color: t.muted, fontSize: 14 }}>{copy.compose.nothing}</Text></Sheet>;
  const card = shared.text ? preview(shared) : null;
  const text = memoText(shared, draft.text);
  const ready = canSend(text, draft.photos) && !importing;

  async function save() {
    if (!shared || !ready || saving) return;
    setSaving(true);
    setNotice(null);
    const r = await fileMemo({ id: draft.id, text, source: shared.source, domainHint: draft.hint, location: fix, photos: draft.photos });
    setSaving(false);
    if (r.kind === 'filed') return BackHandler.exitApp();
    if (r.kind === 'photo-refused') draft.refused(r);
    setNotice(filedText(r));
  }

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
      <Sheet onClose={close}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={{ color: t.fg, fontSize: 17, fontWeight: '600' }}>{copy.compose.title}</Text>
        </View>
        <PhotoStrip picker={picker} disabled={saving} />
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
            value={draft.text}
            onChangeText={draft.setText}
            placeholder={copy.compose.notePlaceholder}
            placeholderTextColor={t.faint}
            style={[st.input, { borderColor: t.line2, backgroundColor: t.bg, color: t.fg }]}
          />
        </View>

        <View style={{ gap: 8 }}>
          <Text style={{ color: t.faint, fontSize: 12, fontWeight: '500' }}>{copy.common.whereToFile}</Text>
          <DomainChips value={draft.hint} onChange={draft.setHint} wrap />
        </View>

        {notice && (
          <Notice tone="bad">
            <Text accessibilityRole="alert" style={{ color: t.bad, fontSize: 14, lineHeight: 21 }}>{notice}</Text>
          </Notice>
        )}
        <PrimaryButton label={saving ? copy.common.saving : copy.common.save} busy={saving || importing} disabled={!ready} onPress={save} />
      </Sheet>
    </KeyboardAvoidingView>
  );
}

const st = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 10, borderWidth: 1 },
  thumb: { width: 40, height: 40, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  input: { height: 44, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, fontSize: 15 },
});
