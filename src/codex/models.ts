/**
 * The models the user's plan may run, from GET /backend-api/codex/models. The response shape is
 * not published. parseModelList is the one place that reads it, written from what the Codex CLI
 * reads (codex-rs ModelsResponse: `models`, each with `slug`, `visibility`,
 * `supported_reasoning_levels`, and `default_reasoning_level`), with the OpenAI `data[].id` list
 * and a bare array as fallbacks.
 */

import type { Fetch } from './auth';
import { CODEX_BASE_URL, EFFORTS, failureFromStatus, headers, type Credentials, type Effort, type ModelFailure } from './responses';

/** A model as the endpoint lists it. `efforts` is null when the listing names none darami knows. */
export type ListedModel = { readonly slug: string; readonly efforts: readonly Effort[] | null; readonly defaultEffort: Effort | null };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isEffort = (v: unknown): v is Effort => (EFFORTS as readonly unknown[]).includes(v);

function efforts(v: unknown): Effort[] | null {
  if (!Array.isArray(v)) return null;
  const known = v.map((e) => (isRecord(e) ? e.effort : e)).filter(isEffort);
  return known.length > 0 ? [...new Set(known)] : null;
}

function listed(item: unknown): ListedModel | null {
  if (typeof item === 'string') return item.trim() ? { slug: item, efforts: null, defaultEffort: null } : null;
  if (!isRecord(item)) return null;
  const slug = [item.slug, item.id, item.model].find((s): s is string => typeof s === 'string' && s.trim() !== '');
  // Codex hides these from its picker: they are internal or retired.
  if (!slug || item.visibility === 'hide' || item.visibility === 'none') return null;
  const defaultEffort = [item.default_reasoning_level, item.default_reasoning_effort].find(isEffort) ?? null;
  return { slug, efforts: efforts(item.supported_reasoning_levels ?? item.supported_reasoning_efforts), defaultEffort };
}

/** The listed models in the endpoint's order, or null for a shape this does not know or a list with no model in it. */
export function parseModelList(raw: unknown): readonly ListedModel[] | null {
  const items = Array.isArray(raw) ? raw : isRecord(raw) ? (Array.isArray(raw.models) ? raw.models : Array.isArray(raw.data) ? raw.data : null) : null;
  if (!items) return null;
  const bySlug = new Map<string, ListedModel>();
  for (const m of items.map(listed)) if (m && !bySlug.has(m.slug)) bySlug.set(m.slug, m);
  return bySlug.size > 0 ? [...bySlug.values()] : null;
}

/** kv's `models.list`, in the endpoint's own shape, so parseModelList reads the cache too. */
export const cacheText = (models: readonly ListedModel[]): string =>
  JSON.stringify({ models: models.map((m) => ({ slug: m.slug, supported_reasoning_levels: m.efforts?.map((effort) => ({ effort })), default_reasoning_level: m.defaultEffort ?? undefined })) });

export function parseCache(text: string | null): readonly ListedModel[] | null {
  try {
    return text ? parseModelList(JSON.parse(text)) : null;
  } catch {
    return null;
  }
}

export type ModelListResult =
  | { readonly ok: true; readonly models: readonly ListedModel[] }
  | { readonly ok: false; readonly failure: ModelFailure | { readonly kind: 'shape'; readonly detail: string } };

/** The endpoint refuses a request without it (422, measured on the emulator). The value is the Codex CLI version darami was checked against. */
export const CLIENT_VERSION = '0.165.0';

export async function listModels(fetchFn: Fetch, creds: Credentials, baseUrl = CODEX_BASE_URL): Promise<ModelListResult> {
  let res: Response;
  let text: string;
  try {
    res = await fetchFn(`${baseUrl}/models?client_version=${CLIENT_VERSION}`, { method: 'GET', headers: { ...headers(creds), accept: 'application/json' } });
    text = await res.text();
  } catch (e) {
    return { ok: false, failure: { kind: 'network', detail: e instanceof Error ? e.message : String(e) } };
  }
  if (res.status < 200 || res.status >= 300) return { ok: false, failure: failureFromStatus(res.status, text, res) };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  const models = parseModelList(raw);
  return models ? { ok: true, models } : { ok: false, failure: { kind: 'shape', detail: text.slice(0, 300) } };
}
