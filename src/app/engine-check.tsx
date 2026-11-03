/**
 * darami://engine-check, dev builds only. Files a typed memo through the engine on the kept folder
 * and the Codex login, and logs every runner report and engine event to console.log with an ENGINE
 * prefix for logcat (ReactNativeJS). adb can type only ASCII, so the link carries the memo
 * percent-encoded:
 *
 *   darami://engine-check?text=<UTF-8 %XX>&hint=<domain, optional>   files the memo once, then runs a pass
 *   darami://engine-check?run=1                                       runs a pass now
 *   add &n=<anything new> to send the same link again
 *
 * Opened with no parameters it only logs: the relaunch after a kill shows the recovery.
 */

import * as Crypto from 'expo-crypto';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, Text, TextInput } from 'react-native';
import { describeProblems } from '../core/pages';
import { fileMemo, observeJobs, runJobs, useApp, type JobNote } from '../state';
import { Header, PrimaryButton, Screen } from '../ui/parts';
import { useTheme } from '../ui/theme';

function lineOf(n: JobNote): string {
  if (n.kind === 'started') return `${n.job.domain} running ${n.job.kind} ${n.job.id} attempt ${n.attempt}`;
  if (n.kind === 'recovered') return `recovered ${n.domain} ${n.slot} ${n.as}${n.job ? ` ${n.job.kind} ${n.job.id}` : ''}`;
  if (n.where === 'runner') return `runner ${n.kind} ${n.message}`;
  if (n.where === 'router') {
    switch (n.kind) {
      case 'routed':
      case 'held':
        return `router ${n.kind} ${n.id} ${n.domain} ${n.routing.by}${n.routing.by === 'classifier' ? ` ${n.routing.confidence}` : ''}`;
      case 'dropped-duplicate': return `router dropped-duplicate ${n.id}`;
      case 'rejected': return `router rejected ${n.file}: ${n.reason}`;
      case 'unavailable': return `router unavailable ${n.unavailable.cause} ${n.unavailable.retryAfterMs} ms: ${n.unavailable.detail}`;
      case 'paused': return `router paused ${n.problems.map((p) => p.key).join(', ')}`;
      case 'cancelled': return 'router cancelled';
    }
  }
  switch (n.kind) {
    case 'committed': return `${n.domain} committed ${n.job.kind} ${n.job.id} ${n.verdict}`;
    case 'retrying': return `${n.domain} retrying ${n.job.kind} ${n.job.id} attempt ${n.attempt}: ${describeProblems(n.problems)}`;
    case 'gave-up': return `${n.domain} gave-up ${n.job.kind} ${n.job.id}: ${describeProblems(n.problems)}`;
    case 'unavailable': return `${n.domain} unavailable ${n.job.kind} ${n.job.id} ${n.unavailable.cause} ${n.unavailable.retryAfterMs} ms: ${n.unavailable.detail}`;
    case 'cancelled': return `${n.domain} cancelled ${n.job.kind} ${n.job.id}`;
    case 'paused': return `${n.domain} paused`;
  }
}

export default function EngineCheck() {
  const t = useTheme();
  const params = useLocalSearchParams<{ text?: string; hint?: string; run?: string; n?: string }>();
  const folder = useApp((a) => a.folder);
  const [log, setLog] = useState<string[]>([]);
  const [text, setText] = useState('');
  const [hint, setHint] = useState('');
  const handled = useRef<string | null>(null);

  const say = (line: string) => {
    console.log(`ENGINE ${line}`);
    setLog((l) => [...l.slice(-300), line]);
  };

  async function file(memo: string, domainHint: string | null) {
    const id = Crypto.randomUUID();
    const r = await fileMemo({ id, text: memo, source: 'typed', domainHint, location: null });
    say(`accepted ${id} ${r.kind}${'detail' in r ? `: ${r.detail}` : 'message' in r ? `: ${r.message}` : ''}`);
  }

  async function pass() {
    say('pass');
    await runJobs();
    say('pass done');
  }

  useEffect(() => (__DEV__ ? observeJobs((n) => say(lineOf(n))) : undefined), []);

  const state = folder?.state?.kind ?? null;
  useEffect(() => {
    if (!__DEV__) return;
    const key = JSON.stringify(params);
    if (handled.current === key || (folder && state === null)) return;
    handled.current = key;
    say(`folder ${folder?.tree.uri ?? 'none'} ${state ?? 'not kept'}`);
    if (typeof params.text === 'string' && params.text !== '') void file(params.text, params.hint ?? null);
    else if (params.run) void pass();
  }, [params.text, params.hint, params.run, params.n, state]);

  if (!__DEV__) return <Redirect href="/" />;
  return (
    <Screen>
      <Header title="Engine check" back />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }}>
        <TextInput value={text} onChangeText={setText} placeholder="memo" multiline style={{ color: t.fg, borderColor: t.line, borderWidth: 1, borderRadius: 8, padding: 8 }} />
        <TextInput value={hint} onChangeText={setHint} placeholder="domain hint (optional)" style={{ color: t.fg, borderColor: t.line, borderWidth: 1, borderRadius: 8, padding: 8 }} />
        <PrimaryButton label="File memo" disabled={text.trim() === ''} onPress={() => void file(text, hint.trim() || null)} />
        <PrimaryButton label="Run a pass now" onPress={() => void pass()} />
        {log.map((l, i) => (
          <Text key={i} selectable style={{ color: / (retrying|gave-up|unavailable|error|unreachable|rejected) /.test(` ${l} `) ? t.bad : t.fg, fontSize: 12, fontFamily: 'monospace' }}>
            {l}
          </Text>
        ))}
      </ScrollView>
    </Screen>
  );
}
