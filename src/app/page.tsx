import { useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { ScrollView, StyleSheet, Text } from 'react-native';
import type { DomainName } from '../core/types';
import { markdownBlocks, pageLabel } from '../lib/markdown';
import { usePage } from '../state';
import { Header, Screen } from '../ui/parts';
import { PhotoBlock } from '../ui/photos';
import { Spans } from '../ui/spans';
import { useTheme } from '../ui/theme';
import { copy } from '../text';

/** A wiki page as of the last commit, read only: from a citation, a link, a saved answer, or a changed page. */
export default function Page() {
  const t = useTheme();
  const { domain, page } = useLocalSearchParams<{ domain: string; page: string }>();
  const ref = useMemo(() => ({ domain: (domain ?? '') as DomainName, page: page ?? '' }), [domain, page]);
  const s = usePage(ref);
  return (
    <Screen>
      <Header title={s.kind === 'shown' ? pageLabel(s.page.path) : copy.page.title} back />
      <ScrollView contentContainerStyle={st.main}>
        {s.kind === 'loading' && <Text style={{ color: t.faint, fontSize: 14 }}>{copy.common.loading}</Text>}
        {s.kind === 'missing' && <Text style={{ color: t.muted, fontSize: 15 }}>{copy.page.missing}</Text>}
        {s.kind === 'shown' && (
          <>
            <Text selectable style={{ color: t.faint, fontSize: 12 }}>
              {[s.page.ref.domain, s.page.type, s.page.updated && copy.page.updated(s.page.updated)].filter(Boolean).join(' · ')}
            </Text>
            {s.page.summary !== '' && <Text selectable style={{ color: t.muted, fontSize: 14, lineHeight: 21 }}>{s.page.summary}</Text>}
            {markdownBlocks(s.page.body.trim()).map((b, i) =>
              b.kind === 'photo' ? <PhotoBlock key={i} file={b.file} /> : <Spans key={i} spans={b.spans} links={s.page.links} />,
            )}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const st = StyleSheet.create({
  main: { paddingVertical: 20, paddingHorizontal: 16, gap: 12 },
});
