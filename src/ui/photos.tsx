import { useCallback, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MAX_PHOTOS } from '../lib/photos';
import { fromCamera } from '../pick';
import { attachmentUri } from '../state';
import type { PhotoHost } from './draft';
import { GallerySheet } from './gallery';
import { Icon } from './icon';
import { SmallButton } from './parts';
import { useTheme } from './theme';
import { copy } from '../text';

/** The gallery sheet, the camera, and their notices for a draft's photos. The memo tab and the share sheet share it. */
export function usePhotoPicker(host: PhotoHost) {
  const [gallery, setGallery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { addPhotos } = host;

  const camera = useCallback(async () => {
    setNotice(null);
    setBusy(true);
    try {
      const r = await fromCamera();
      if (r === 'denied') setNotice(copy.photos.cameraDenied);
      else if (r) addPhotos([r]);
    } catch {
      setNotice(copy.photos.importFailed);
    } finally {
      setBusy(false);
    }
  }, [addPhotos]);

  return {
    host,
    busy,
    notice,
    camera,
    openGallery: () => (setNotice(null), setGallery(true)),
    sheet: (
      <GallerySheet
        visible={gallery}
        room={MAX_PHOTOS - host.photos.length}
        onClose={() => setGallery(false)}
        onDone={(picked) => {
          setGallery(false);
          addPhotos(picked);
        }}
      />
    ),
  };
}

export type PhotoPicker = ReturnType<typeof usePhotoPicker>;

/** Gallery and camera, as small bordered buttons. */
export function PhotoButtons({ picker, disabled }: { picker: PhotoPicker; disabled?: boolean }) {
  const t = useTheme();
  const off = disabled || picker.busy || picker.host.photos.length >= MAX_PHOTOS;
  return (
    <View style={st.buttons}>
      <SmallButton label={copy.photos.pick} icon="image" disabled={off} onPress={picker.openGallery} />
      <SmallButton label={copy.photos.take} icon="camera" disabled={off} onPress={() => void picker.camera()} />
      {picker.busy && <ActivityIndicator size="small" color={t.faint} />}
    </View>
  );
}

export function PhotoStrip({ picker, disabled }: { picker: PhotoPicker; disabled?: boolean }) {
  const t = useTheme();
  const { photos } = picker.host;
  if (photos.length === 0 && !picker.notice) return null;
  return (
    <View style={{ gap: 6 }}>
      {photos.length > 0 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} keyboardShouldPersistTaps="handled">
          {photos.map((p, i) => (
            <View key={p.uri}>
              <Image source={{ uri: p.uri }} resizeMethod="resize" style={[st.thumb, { backgroundColor: t.bg3 }]} accessibilityLabel={copy.photos.nth(i + 1, p.place)} />
              {!disabled && (
                <Pressable accessibilityRole="button" accessibilityLabel={copy.photos.remove(i + 1)} hitSlop={8} onPress={() => picker.host.removePhoto(p.uri)} style={[st.remove, { backgroundColor: t.scrim }]}>
                  <Icon name="x" size={12} color="#ffffff" strokeWidth={2.5} />
                </Pressable>
              )}
            </View>
          ))}
        </ScrollView>
      )}
      {picker.notice && <Text style={{ color: t.warn, fontSize: 12 }}>{picker.notice}</Text>}
    </View>
  );
}

/** The small photo count mark on a memo row. */
export function PhotoCount({ count }: { count: number }) {
  const t = useTheme();
  if (count <= 0) return null;
  return (
    <View style={st.count} accessibilityLabel={copy.photos.count(count)}>
      <Icon name="image" size={12} color={t.faint} />
      <Text style={{ color: t.faint, fontSize: 12 }}>{count}</Text>
    </View>
  );
}

/** A memo's copies in the wiki folder, read by Image from their document URIs: no photo byte crosses the JS thread. */
export function MemoThumbs({ files }: { files: readonly string[] }) {
  const t = useTheme();
  if (files.length === 0) return null;
  return (
    <View style={st.thumbs}>
      {files.map((f, i) => {
        const uri = attachmentUri(f);
        return uri ? <Image key={f} source={{ uri }} resizeMethod="resize" style={[st.memoThumb, { backgroundColor: t.bg3 }]} accessibilityLabel={copy.photos.nth(i + 1, null)} /> : null;
      })}
    </View>
  );
}

/** A copy at full width in the page viewer, its height from the image once it loads. One that is gone shows its name. */
export function PhotoBlock({ file }: { file: string }) {
  const t = useTheme();
  const uri = attachmentUri(file);
  const [ratio, setRatio] = useState(4 / 3);
  const [failed, setFailed] = useState(false);
  if (!uri || failed) return <Text style={{ color: t.muted, fontSize: 15 }}>{copy.page.photo(file)}</Text>;
  return (
    <Image
      source={{ uri }}
      resizeMethod="resize"
      accessibilityLabel={copy.page.photo(file)}
      onLoad={(e) => setRatio(e.nativeEvent.source.width / e.nativeEvent.source.height)}
      onError={() => setFailed(true)}
      style={{ width: '100%', aspectRatio: ratio, borderRadius: 8, backgroundColor: t.bg3 }}
    />
  );
}

const st = StyleSheet.create({
  buttons: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  thumb: { width: 64, height: 64, borderRadius: 8 },
  remove: { position: 'absolute', top: 4, right: 4, width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  count: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  thumbs: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  memoThumb: { width: 72, height: 72, borderRadius: 8 },
});
