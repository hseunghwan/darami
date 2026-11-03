/**
 * P0 spike: log in to ChatGPT by device code and run one classify and one tool round trip
 * against the Codex endpoint, on the phone. Open it with darami://codex-probe. It goes away
 * once onboarding owns the login (docs/plan.md, P4).
 */

import * as Clipboard from 'expo-clipboard';
import { useRef, useState } from 'react';
import { Linking, ScrollView, Text, View } from 'react-native';
import { completeDeviceLogin, requestDeviceCode, type DeviceCode } from '../codex/auth';
import { runTurn, type FunctionTool, type InputItem, type TurnRequest } from '../codex/responses';
import { credentials, loadTokens, logOut, saveTokens } from '../codex/session';
import { jobsLoggedIn } from '../state';
import { Card, Header, PrimaryButton, Screen, SmallButton } from '../ui/parts';
import { useTheme } from '../ui/theme';

const MODEL = 'gpt-6-luna';

const readFile: FunctionTool = {
  type: 'function',
  name: 'read_file',
  description: 'Read a file in the wiki',
  strict: true,
  parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' } } },
};

const user = (text: string): InputItem => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });

export default function CodexProbe() {
  const t = useTheme();
  const [log, setLog] = useState<string[]>([]);
  const [code, setCode] = useState<DeviceCode | null>(null);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const say = (line: string) => setLog((l) => [...l, `${new Date().toLocaleTimeString()}  ${line}`]);

  const run = (fn: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      say(`threw: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const login = run(async () => {
    const c = await requestDeviceCode(fetch);
    if (!c.ok) return say(`device code: ${JSON.stringify(c.failure)}`);
    setCode(c.value);
    say(`code ${c.value.userCode}, expires ${new Date(c.value.expiresAt).toLocaleTimeString()}`);
    abort.current = new AbortController();
    const r = await completeDeviceLogin(fetch, c.value, { signal: abort.current.signal });
    setCode(null);
    if (!r.ok) return say(`login: ${JSON.stringify(r.failure)}`);
    await saveTokens(r.value);
    void jobsLoggedIn();
    say(`logged in: ${r.value.email ?? '?'} (${r.value.plan ?? '?'}), token until ${new Date(r.value.expiresAt).toLocaleString()}`);
  });

  const status = run(async () => {
    const tk = await loadTokens();
    say(tk ? `stored: ${tk.email ?? '?'} (${tk.plan ?? '?'}), token until ${new Date(tk.expiresAt).toLocaleString()}` : 'not logged in');
  });

  const refresh = run(async () => {
    const r = await credentials(fetch, { force: true });
    say(r.ok ? `refreshed, token until ${new Date(r.tokens.expiresAt).toLocaleString()}` : `refresh: ${JSON.stringify(r.failure)}`);
  });

  const turn = async (req: TurnRequest) => {
    const c = await credentials(fetch);
    if (!c.ok) {
      say(`credentials: ${JSON.stringify(c.failure)}`);
      return null;
    }
    const t0 = Date.now();
    const r = await runTurn(fetch, c.creds, req);
    say(`${Date.now() - t0} ms: ${JSON.stringify(r.ok ? { output: r.output, usage: r.usage } : r.failure).slice(0, 400)}`);
    return r;
  };

  const classify = run(async () => {
    await turn({
      model: MODEL,
      effort: 'low',
      instructions: 'Pick the domain this memo belongs to. journal: what happened in the day. study: what the user learned. later: things to look at later.',
      input: [user('Tried pgvector today. An HNSW index made the search much faster than a full scan.')],
      schema: {
        name: 'classification',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['domain', 'confidence', 'reason'],
          properties: { domain: { type: 'string', enum: ['journal', 'study', 'later'] }, confidence: { type: 'number' }, reason: { type: 'string' } },
        },
      },
    });
  });

  const toolRoundTrip = run(async () => {
    const base: TurnRequest = { model: MODEL, effort: 'low', instructions: 'Use read_file to read notes.md, then say what it holds.', input: [user('What is in notes.md?')], tools: [readFile] };
    const first = await turn(base);
    if (!first?.ok) return;
    const call = first.output.find((o) => o.type === 'function_call');
    if (!call || call.type !== 'function_call') return say('no function call came back');
    say(`model called ${call.name}(${call.arguments})`);
    await turn({ ...base, input: [...base.input, call, { type: 'function_call_output', call_id: call.call_id, output: '# Notes\nThe acorn is buried under the oak.' }] });
  });

  return (
    <Screen>
      <Header title="Codex probe" back />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        {code && (
          <Card style={{ gap: 8 }}>
            <Text style={{ color: t.muted }}>Open {code.verificationUrl} and enter</Text>
            <Text selectable style={{ color: t.fg, fontSize: 28, fontWeight: '700', letterSpacing: 2 }}>
              {code.userCode}
            </Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <SmallButton label="Copy code" onPress={() => void Clipboard.setStringAsync(code.userCode)} />
              <SmallButton label="Open page" onPress={() => void Linking.openURL(code.verificationUrl)} />
              <SmallButton label="Cancel" onPress={() => abort.current?.abort()} />
            </View>
          </Card>
        )}
        <PrimaryButton label="Log in with ChatGPT" onPress={login} busy={busy && code !== null} disabled={busy} />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <SmallButton label="Status" onPress={status} disabled={busy} />
          <SmallButton label="Refresh" onPress={refresh} disabled={busy} />
          <SmallButton label="Classify" onPress={classify} disabled={busy} />
          <SmallButton label="Tool round trip" onPress={toolRoundTrip} disabled={busy} />
          <SmallButton label="Log out" onPress={() => void logOut().then(() => say('logged out'))} disabled={busy} />
        </View>
        <Card>
          <Text selectable style={{ color: t.fg, fontFamily: 'monospace', fontSize: 12 }}>
            {log.join('\n') || 'Nothing yet.'}
          </Text>
        </Card>
      </ScrollView>
    </Screen>
  );
}
