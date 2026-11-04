import assert from 'node:assert/strict';
import { effortsFor, settleChoice, type ModelChoice } from '../../agent/model';
import { cacheText, listModels, parseCache, parseModelList } from '../models';

const levels = (...e: string[]) => e.map((effort) => ({ effort, description: `${effort} effort` }));

/** What codex-rs reads from the endpoint, with fields darami ignores left in. */
const CODEX_SHAPE = {
  models: [
    { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list', supported_in_api: true, priority: 1, default_reasoning_level: 'medium', supported_reasoning_levels: levels('low', 'medium', 'high', 'xhigh') },
    { slug: 'gpt-6-luna', visibility: 'list', default_reasoning_level: 'low', supported_reasoning_levels: levels('minimal', 'low', 'medium') },
    { slug: 'codex-auto-review', visibility: 'hide', supported_reasoning_levels: levels('low') },
    { slug: 'gpt-5.6', visibility: 'none' },
    { slug: 'gpt-6-astra' },
  ],
};

test('the Codex shape lists each visible model in order, with the efforts darami knows and its default', () => {
  assert.deepEqual(parseModelList(CODEX_SHAPE), [
    { slug: 'gpt-6.1-sol', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
    { slug: 'gpt-6-luna', efforts: ['minimal', 'low', 'medium'], defaultEffort: 'low' },
    { slug: 'gpt-6-astra', efforts: null, defaultEffort: null },
  ]);
});

test('an OpenAI data list, a bare array of names, and efforts as plain strings parse too', () => {
  assert.deepEqual(parseModelList({ object: 'list', data: [{ id: 'gpt-6-sol', object: 'model' }] }), [{ slug: 'gpt-6-sol', efforts: null, defaultEffort: null }]);
  assert.deepEqual(parseModelList(['gpt-6-sol', 'gpt-6-sol', 'gpt-6-luna']), [
    { slug: 'gpt-6-sol', efforts: null, defaultEffort: null },
    { slug: 'gpt-6-luna', efforts: null, defaultEffort: null },
  ]);
  assert.deepEqual(parseModelList([{ slug: 'gpt-6-sol', supported_reasoning_efforts: ['high', 'turbo'], default_reasoning_effort: 'high' }]), [{ slug: 'gpt-6-sol', efforts: ['high'], defaultEffort: 'high' }]);
});

test('a shape with no model in it is null, never an empty list', () => {
  for (const raw of [null, 'gpt-6-sol', {}, { models: [] }, { models: [{ slug: 'x', visibility: 'hide' }] }, { detail: 'Unauthorized' }, [{ name: 7 }]]) {
    assert.equal(parseModelList(raw), null, JSON.stringify(raw));
  }
});

test('the cache reads back as the list it was written from', () => {
  const list = parseModelList(CODEX_SHAPE)!;
  assert.deepEqual(parseCache(cacheText(list)), list);
  assert.equal(parseCache(null), null);
  assert.equal(parseCache('{broken'), null);
});

test('listModels sends the login headers and reads the list, and answers a refusal or an unknown body as a failure', async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const answer = (status: number, body: string) =>
    (async (url: string, init: { headers: Record<string, string> }) => (seen.push({ url, headers: init.headers }), new Response(body, { status }))) as unknown as typeof fetch;
  const creds = { accessToken: 'tok', accountId: 'acct' };

  const r = await listModels(answer(200, JSON.stringify(CODEX_SHAPE)), creds);
  assert.ok(r.ok);
  assert.deepEqual(r.models.map((m) => m.slug), ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra']);
  assert.equal(seen[0]!.url, 'https://chatgpt.com/backend-api/codex/models');
  assert.equal(seen[0]!.headers.authorization, 'Bearer tok');
  assert.equal(seen[0]!.headers['chatgpt-account-id'], 'acct');
  assert.equal(seen[0]!.headers.originator, 'darami');

  const refused = await listModels(answer(401, '{"detail":"bad token"}'), creds);
  assert.deepEqual(refused, { ok: false, failure: { kind: 'unauthorized', detail: 'bad token' } });
  const odd = await listModels(answer(200, '{"items":[]}'), creds);
  assert.deepEqual(odd, { ok: false, failure: { kind: 'shape', detail: '{"items":[]}' } });
});

test('a stored effort the listed model no longer offers falls back to its default, and an unlisted model keeps its pick', () => {
  const list = parseModelList(CODEX_SHAPE)!;
  const choice: ModelChoice = { filing: { model: 'gpt-6-luna', effort: 'high' }, ask: { model: 'gpt-6.1-sol', effort: 'high' } };
  assert.deepEqual(settleChoice(choice, list), { filing: { model: 'gpt-6-luna', effort: 'low' }, ask: { model: 'gpt-6.1-sol', effort: 'high' } });
  const gone: ModelChoice = { filing: { model: 'gpt-7', effort: 'high' }, ask: { model: 'gpt-6-astra', effort: 'minimal' } };
  assert.deepEqual(settleChoice(gone, list), gone, 'no list entry or no efforts listed: the endpoint decides');
  assert.deepEqual(settleChoice(choice, null), choice);
  assert.deepEqual(effortsFor(list[1]), ['minimal', 'low', 'medium']);
  assert.deepEqual(effortsFor(list[2]), ['minimal', 'low', 'medium', 'high'], 'no efforts listed: all four');
});
