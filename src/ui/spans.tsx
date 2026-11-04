import { router } from 'expo-router';
import { Text, type StyleProp, type TextStyle } from 'react-native';
import type { PageRef } from '../core/pages';
import type { Span } from '../lib/markdown';
import { useTheme } from './theme';
import { copy } from '../text';

/** The read-only page viewer, for a citation, an inline link, a saved answer, or a changed page. */
export const openPage = (ref: PageRef): void => router.push({ pathname: '/page', params: { domain: ref.domain, page: ref.page } });

/** Markdown spans as one selectable text. A link opens the viewer only when `links` names its page. */
export function Spans({ spans, links, style }: { spans: readonly Span[]; links: ReadonlyMap<string, PageRef> | null; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  return (
    <Text selectable style={[{ color: t.fg, fontSize: 15, lineHeight: 24.75 }, style]}>
      {spans.map((span, i) => {
        if (span.kind === 'text') return span.text;
        if (span.kind === 'bold') return <Text key={i} style={{ fontWeight: '600' }}>{span.text}</Text>;
        if (span.kind === 'embed') return <Text key={i} style={{ color: t.muted }}>{copy.page.photo(span.text)}</Text>;
        const ref = links?.get(span.target);
        return ref ? (
          <Text key={i} accessibilityRole="link" onPress={() => openPage(ref)} style={{ color: t.link }}>
            {span.text}
          </Text>
        ) : (
          <Text key={i} style={{ color: t.link }}>
            {span.text}
          </Text>
        );
      })}
    </Text>
  );
}
