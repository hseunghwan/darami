import * as Clipboard from 'expo-clipboard';
import * as Crypto from 'expo-crypto';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type ScrollViewInstance } from 'react-native';
import { parseChatId, type ChatId } from '../../core/chat';
import type { ChatTarget, MemoId } from '../../core/types';
import type { AnsweredTurn, ChatTurn, ChatView } from '../../jobs/engine';
import { readingText, refusedText, sameTarget, saveButton, savedText, targetLabel } from '../../lib/chats';
import { markdownSpans, pageLabel } from '../../lib/markdown';
import { askWiki, openChat, pastChats, rememberQuestion, saveAnswer, useApp, useDomains } from '../../state';
import { Icon, type IconName } from '../../ui/icon';
import { Chip, Screen, ScreenTitle } from '../../ui/parts';
import { openPage, Spans } from '../../ui/spans';
import { useTheme } from '../../ui/theme';
import { copy } from '../../text';

/** The question running now, before the engine answers it with a stored turn. */
type Streaming = { readonly kind: 'streaming'; readonly key: string; readonly question: string; readonly draft: string; readonly reading: readonly string[] };
type Shown = ChatTurn | Streaming;
/** The chat open for one target chip. The id is minted when it opens, so asking never waits on the engine for one. */
type Conversation = { readonly chat: ChatId; readonly turns: readonly Shown[] };

const ROOT: ChatTarget = { kind: 'root' };
const keyOf = (t: ChatTarget) => (t.kind === 'root' ? '' : `d:${t.domain}`);
const fresh = (): Conversation => ({ chat: parseChatId(Crypto.randomUUID())!, turns: [] });
const fromView = (v: ChatView): Conversation => ({ chat: v.id, turns: v.turns });
const streaming = (c: Conversation | undefined) => c?.turns.at(-1)?.kind === 'streaming';

function ActButton({ label, icon, on, onPress, small }: { label: string; icon: IconName; on?: boolean; onPress: () => void; small?: boolean }) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!on }}
      onPress={onPress}
      style={[st.act, { height: small ? 30 : 32, paddingHorizontal: small ? 10 : 12, backgroundColor: on ? t.okBg : 'transparent', borderColor: on ? t.okLine : t.line2 }]}
    >
      <Icon name={icon} size={14} color={on ? t.okFg : t.muted} />
      <Text style={{ color: on ? t.okFg : t.muted, fontSize: small ? 12 : 13 }}>{label}</Text>
    </Pressable>
  );
}

function HeaderButton({ icon, label, onPress, disabled }: { icon: IconName; label: string; onPress: () => void; disabled?: boolean }) {
  const t = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} style={st.headerButton}>
      <Icon name={icon} size={20} color={disabled ? t.faint : t.muted} />
    </Pressable>
  );
}

/** The question bubble, and Remember under it once the turn is stored. Remembered is read from the memo book. */
function Question({ text, memo, target, onToast }: { text: string; memo: MemoId | null; target: ChatTarget; onToast: (s: string) => void }) {
  const t = useTheme();
  const at = useApp((a) => (memo ? a.book?.byId.get(memo)?.at : undefined));
  const [saving, setSaving] = useState(false);
  const domain = at && 'domain' in at ? at.domain : null;
  const label = at ? (domain ? copy.chat.rememberedIn(domain) : copy.chat.remembered) : saving ? copy.common.saving : copy.chat.remember;
  async function remember() {
    if (!memo || at || saving) return;
    setSaving(true);
    const r = await rememberQuestion({ memo, question: text }, target);
    setSaving(false);
    if (r.kind !== 'filed') onToast(copy.chat.rememberFailed);
  }
  return (
    <View style={st.mine}>
      <View style={[st.bubble, { backgroundColor: t.bubble }]}>
        <Text selectable style={{ color: t.fg, fontSize: 15, lineHeight: 22.5 }}>{text}</Text>
      </View>
      {memo && <ActButton small icon="pencil" label={label} on={!!at} onPress={remember} />}
    </View>
  );
}

/** A stored answer: its text with tappable citations, the chips, Save answer from the memo book, and Copy. */
function Answer({ turn, chat, onToast }: { turn: AnsweredTurn; chat: ChatId; onToast: (s: string) => void }) {
  const t = useTheme();
  const placed = useApp((a) => a.book?.answers.get(turn.answerId));
  const [saving, setSaving] = useState(false);
  const button = saveButton(placed, saving);
  async function save() {
    if (button.opens) return openPage(button.opens);
    if (!button.saves) return;
    setSaving(true);
    const note = savedText(await saveAnswer({ chat, n: turn.n }));
    setSaving(false);
    if (note) onToast(note);
  }
  return (
    <View style={{ gap: 12 }}>
      <Spans spans={markdownSpans(turn.answer)} links={turn.links} />
      {turn.cited.length > 0 && (
        <View style={st.cites}>
          {turn.cited.map((ref) => (
            <Pressable key={`${ref.domain}/${ref.page}`} accessibilityRole="button" accessibilityLabel={pageLabel(ref.page)} onPress={() => openPage(ref)} style={[st.cite, { backgroundColor: t.bg2 }]}>
              <Icon name="file" size={12} color={t.link} />
              <Text style={{ color: t.link, fontSize: 12 }}>{pageLabel(ref.page)}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {turn.saveTo && <ActButton icon="bookmark" label={button.label} on={button.on} onPress={save} />}
        <ActButton
          icon="copy"
          label={copy.chat.copy}
          onPress={() => void Clipboard.setStringAsync(turn.answer).then(() => onToast(copy.chat.copied), () => {})}
        />
      </View>
    </View>
  );
}

function TurnView({ turn, chat, target, onToast }: { turn: Shown; chat: ChatId; target: ChatTarget; onToast: (s: string) => void }) {
  const t = useTheme();
  return (
    <View style={{ gap: 20 }}>
      <Question text={turn.question} memo={turn.kind === 'streaming' ? null : turn.memo} target={target} onToast={onToast} />
      {turn.kind === 'answered' && <Answer turn={turn} chat={chat} onToast={onToast} />}
      {turn.kind === 'failed' && <Text style={{ color: t.bad, fontSize: 14, lineHeight: 21 }}>{copy.chat.failure[turn.failure]}</Text>}
      {turn.kind === 'streaming' &&
        (turn.draft ? <Spans spans={markdownSpans(turn.draft)} links={null} /> : <Text style={{ color: t.faint, fontSize: 15 }}>{readingText(turn.reading)}</Text>)}
    </View>
  );
}

export default function Chat() {
  const t = useTheme();
  const domains = useDomains();
  const { open } = useLocalSearchParams<{ open?: string }>();
  const [target, setTarget] = useState<ChatTarget>(ROOT);
  const [convs, setConvs] = useState<Record<string, Conversation>>({});
  const convsRef = useRef(convs);
  convsRef.current = convs;
  const [draft, setDraft] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const scroll = useRef<ScrollViewInstance>(null);
  const running = useRef<AbortController | null>(null);
  const limitedUntil = useApp((a) => (a.jobs.paused?.cause === 'rate-limited' ? a.jobs.paused.until : null));
  const loggedOut = useApp((a) => a.login.kind === 'expired');

  useEffect(() => () => running.current?.abort(), []);

  const update = useCallback((k: string, f: (c: Conversation) => Conversation) => setConvs((all) => (all[k] ? { ...all, [k]: f(all[k]!) } : all)), []);

  /** On focus: the open chat as stored now (a chat deleted in Past chats becomes a new one), or the target's latest. */
  useFocusEffect(
    useCallback(() => {
      const k = keyOf(target);
      const was = convsRef.current[k];
      if (streaming(was)) return;
      void (async () => {
        const id = was ? was.chat : (await pastChats())?.find((c) => sameTarget(c.target, target))?.id;
        const view = id ? await openChat(id) : null;
        setConvs((all) => {
          const now = all[k];
          if ((now && now.chat !== was?.chat) || streaming(now)) return all;
          return { ...all, [k]: view ? fromView(view) : now && now.turns.length === 0 ? now : fresh() };
        });
      })();
    }, [target]),
  );

  useEffect(() => {
    if (!open) return;
    router.setParams({ open: undefined });
    const id = parseChatId(open);
    if (!id) return;
    void (async () => {
      const view = await openChat(id);
      if (!view) return setToast(copy.chat.openFailed);
      const k = keyOf(view.target);
      setConvs((all) => (streaming(all[k]) ? all : { ...all, [k]: fromView(view) }));
      setTarget(view.target);
    })();
  }, [open]);

  useEffect(() => {
    if (!toast) return;
    // The toast takes room above the input; keep the buttons it would cover in view.
    requestAnimationFrame(() => scroll.current?.scrollToEnd({ animated: true }));
    const timer = setTimeout(() => setToast(null), 3_000);
    return () => clearTimeout(timer);
  }, [toast]);

  const key = keyOf(target);
  const conv = convs[key];
  const busy = streaming(conv);

  async function ask() {
    const text = draft.trim();
    if (!text || busy || !conv) return;
    const k = key;
    const turnKey = Crypto.randomUUID();
    const mine = (x: Shown): x is Streaming => x.kind === 'streaming' && x.key === turnKey;
    setDraft('');
    update(k, (c) => ({ ...c, turns: [...c.turns, { kind: 'streaming', key: turnKey, question: text, draft: '', reading: [] }] }));
    const abort = new AbortController();
    running.current = abort;
    const r = await askWiki(
      { chat: conv.chat, target, text },
      (p) => update(k, (c) => ({ ...c, turns: c.turns.map((x) => (!mine(x) ? x : p.kind === 'text' ? { ...x, draft: p.text } : { ...x, draft: '', reading: p.paths })) })),
      abort.signal,
    );
    if (running.current === abort) running.current = null;
    const kept = r.kind === 'answered' || r.kind === 'failed' ? r.turn : null;
    update(k, (c) => ({ ...c, turns: c.turns.flatMap((x) => (!mine(x) ? [x] : kept ? [kept] : [])) }));
    if (!kept) setDraft((d) => d || text);
    const note = r.kind === 'failed' && r.retryAt !== null ? copy.chat.limited(new Date(r.retryAt)) : refusedText(r);
    if (note) setToast(note);
  }

  const canSend = !busy && !!conv && draft.trim() !== '';

  return (
    <Screen>
      <View style={[st.header, { borderBottomColor: t.line }]}>
        <View style={st.titleRow}>
          <ScreenTitle title={copy.chat.title} mark />
          <View style={{ flexDirection: 'row' }}>
            <HeaderButton icon="plus" label={copy.chat.newChat} disabled={busy || !conv || conv.turns.length === 0} onPress={() => setConvs((all) => ({ ...all, [key]: fresh() }))} />
            <HeaderButton icon="history" label={copy.chat.pastChats} onPress={() => router.push('/chats')} />
          </View>
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} accessibilityLabel={copy.chat.targets}>
          <Chip small label={copy.common.all} on={target.kind === 'root'} onPress={() => setTarget(ROOT)} />
          {domains.map((d) => (
            <Chip small key={d} label={d} on={target.kind === 'domain' && target.domain === d} onPress={() => setTarget({ kind: 'domain', domain: d })} />
          ))}
        </ScrollView>
      </View>
      {(limitedUntil !== null || loggedOut) && (
        <View style={[st.banner, { backgroundColor: t.warnBg }]}>
          <Text style={{ color: t.warn, fontSize: 13, lineHeight: 19 }}>{loggedOut ? copy.chat.loggedOut : copy.chat.limited(new Date(limitedUntil!))}</Text>
        </View>
      )}

      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <ScrollView ref={scroll} contentContainerStyle={st.main} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })} keyboardShouldPersistTaps="handled">
          {conv && conv.turns.length === 0 && (
            <View style={{ paddingVertical: 24, gap: 6, alignItems: 'center' }}>
              <Text style={{ color: t.muted, fontSize: 14 }}>{target.kind === 'root' ? copy.chat.askAll : copy.chat.askDomain(targetLabel(target))}</Text>
              <Text style={{ color: t.faint, fontSize: 13, lineHeight: 21, textAlign: 'center' }}>{copy.chat.example}</Text>
            </View>
          )}
          {conv?.turns.map((turn) => <TurnView key={turn.kind === 'streaming' ? turn.key : `n${turn.n}`} turn={turn} chat={conv.chat} target={target} onToast={setToast} />)}
        </ScrollView>

        {toast && (
          <View accessibilityRole="alert" style={[st.toast, { backgroundColor: t.bg2, borderColor: t.cardLine }]}>
            <Text style={{ color: t.muted, fontSize: 13 }}>{toast}</Text>
          </View>
        )}
        <View style={st.form}>
          <TextInput
            accessibilityLabel={copy.chat.input}
            value={draft}
            onChangeText={setDraft}
            placeholder={copy.chat.placeholder}
            placeholderTextColor={t.faint}
            onSubmitEditing={ask}
            returnKeyType="send"
            style={[st.input, { borderColor: t.line2, backgroundColor: t.bg2, color: t.fg }]}
          />
          {busy ? (
            <Pressable accessibilityRole="button" accessibilityLabel={copy.common.stop} onPress={() => running.current?.abort()} style={[st.send, { backgroundColor: t.btn }]}>
              <Icon name="x" size={20} strokeWidth={2} color={t.btnFg} />
            </Pressable>
          ) : (
            <Pressable accessibilityRole="button" accessibilityLabel={copy.common.send} accessibilityState={{ disabled: !canSend }} onPress={ask} style={[st.send, { backgroundColor: canSend ? t.btn : t.btnOff }]}>
              <Icon name="arrowUp" size={20} strokeWidth={2} color={canSend ? t.btnFg : t.btnOffFg} />
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const st = StyleSheet.create({
  header: { paddingVertical: 12, paddingHorizontal: 16, gap: 12, borderBottomWidth: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 32 },
  headerButton: { width: 40, height: 40, marginVertical: -4, alignItems: 'center', justifyContent: 'center' },
  banner: { paddingVertical: 10, paddingHorizontal: 16 },
  main: { paddingVertical: 20, paddingHorizontal: 16, gap: 20 },
  mine: { alignSelf: 'flex-end', maxWidth: '80%', alignItems: 'flex-end', gap: 6 },
  bubble: { paddingVertical: 10, paddingHorizontal: 14, borderTopLeftRadius: 14, borderTopRightRadius: 14, borderBottomLeftRadius: 14, borderBottomRightRadius: 4 },
  act: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 8, borderWidth: 1 },
  cites: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  cite: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 26, paddingHorizontal: 8, borderRadius: 6 },
  toast: { marginHorizontal: 16, marginBottom: 8, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1 },
  form: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 8, paddingHorizontal: 16, paddingBottom: 12 },
  input: { flex: 1, height: 44, paddingHorizontal: 14, borderRadius: 22, borderWidth: 1, fontSize: 15 },
  send: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
});
