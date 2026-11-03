/**
 * Every move of a memo file: accept and route. dotoriwiki moved memos with link() and rename(),
 * which SAF does not have, so the rule here is copy, read back, then delete: a memo file is deleted
 * only after the copy that replaces it reads back whole, and a copy that does not parse beside a
 * whole one is a cut-off write, the one that gets deleted. Memo files are not journaled: every step
 * is a create or a remove, so a rerun after a kill at any step redoes only what is missing.
 */

import { domainIn, type WikiConfig } from '../core/config';
import { CLASSIFY_TRIES, classifierInstructions, classifierText, HOLD_BELOW } from '../core/filing';
import type { Fs } from '../core/fs';
import { parseWikiPath, paths, type WikiPath } from '../core/layout';
import { parseMemoFile, renderMemoFile, type Memo, type Routing } from '../core/pages';
import { locate, orderKey, type Places } from '../core/places';
import { textFor } from '../core/text';
import type { DomainName, MemoId } from '../core/types';
import { readPlaces } from '../core/wiki';
import { classify, type Unavailable } from '../agent/model';
import type { Ctx, Engine, RouteReport } from './engine';

export const memoFile = {
  inbox: (id: MemoId) => `${paths.inbox}/${id}.md` as WikiPath,
  raw: (d: DomainName, id: MemoId) => `${paths.raw(d)}/${id}.md` as WikiPath,
  hold: (d: DomainName, id: MemoId) => `${paths.hold(d)}/${id}.md` as WikiPath,
  source: (d: DomainName, id: MemoId) => `${paths.raw(d)}/${id}.source.md` as WikiPath,
};

const idOf = (text: string | null): MemoId | null => {
  const p = text ? parseMemoFile(text) : null;
  return p?.ok ? p.value.memo.id : null;
};

/** True when `text` is a whole memo file for `id`. */
const isMemo = (text: string | null, id: MemoId): boolean => idOf(text) === id;

/**
 * `to` holds `text`, read back. A whole copy of the same memo already there is kept, because it is
 * that memo, maybe with the routing an earlier run gave it. Anything else there is a cut-off copy
 * and is replaced. Throws when the copy does not read back, so the caller's delete never runs.
 */
async function copyWhole(fs: Fs, to: WikiPath, text: string): Promise<void> {
  if ((await fs.create(to, text)) === 'created' && (await fs.readText(to)) === text) return;
  const there = await fs.readText(to);
  const id = idOf(text);
  if (there === text || (id !== null && isMemo(there, id))) return;
  await fs.write(to, text);
  if ((await fs.readText(to)) !== text) throw new Error(`${to} does not read back`);
}

/** The memo is never in zero places. */
async function relocate(fs: Fs, from: WikiPath, to: WikiPath, text: string): Promise<void> {
  await copyWhole(fs, to, text);
  await fs.remove(from);
}

type Decision = { readonly domain: DomainName; readonly routing: Routing };

export function memoTransitions(ctx: Ctx): Pick<Engine, 'accept' | 'routeNext' | 'locate'> {
  const { fs } = ctx;
  const places = async (config: WikiConfig): Promise<Places> => readPlaces(fs, config, await ctx.journal.running());

  /** Inside the memo lane: rejects a bad inbox file, or drops a duplicate, or answers the oldest memo to route. */
  async function pickNext(config: WikiConfig): Promise<RouteReport | Memo> {
    const memos: Memo[] = [];
    for (const name of await fs.list(paths.inbox)) {
      const path = name.endsWith('.md') ? parseWikiPath(`${paths.inbox}/${name}`) : null;
      const text = path ? await fs.readText(path) : null;
      // Empty: an accept cut off between making the file and writing it.
      if (!path || !text) continue;
      const parsed = parseMemoFile(text);
      if (!parsed.ok || `${parsed.value.memo.id}.md` !== name) {
        await relocate(fs, path, `${paths.rejected}/${name}` as WikiPath, text);
        return { kind: 'rejected', file: name, reason: parsed.ok ? 'file name does not match id' : parsed.detail };
      }
      memos.push(parsed.value.memo);
    }
    const memo = memos.sort((a, b) => (orderKey(a.capturedAt, a.id) < orderKey(b.capturedAt, b.id) ? -1 : 1))[0];
    if (!memo) return { kind: 'idle' };
    const at = locate(await places(config), memo.id);
    if (at) {
      const copy = at.state === 'held' ? memoFile.hold(at.domain, memo.id) : memoFile.raw(at.domain, memo.id);
      if ((at.state !== 'routed' && at.state !== 'held') || isMemo(await fs.readText(copy), memo.id)) {
        await fs.remove(memoFile.inbox(memo.id));
        return { kind: 'dropped-duplicate', id: memo.id };
      }
      // The router's own copy, cut off: the inbox copy is still whole, so route it again.
      await fs.remove(copy);
    }
    return memo;
  }

  async function decide(config: WikiConfig, memo: Memo, signal: AbortSignal): Promise<Decision | Unavailable | { readonly kind: 'cancelled' }> {
    const hinted = memo.domainHint ? domainIn(config, memo.domainHint) : null;
    if (hinted) return { domain: hinted, routing: { by: 'hint' } };
    const t = textFor(config.locale);
    const req = {
      instructions: classifierInstructions((await fs.readText(paths.rootSchema)) ?? '', config, t),
      text: classifierText(memo, t),
      domains: [...config.domains.keys()],
    };
    let detail = '';
    for (let i = 0; i < CLASSIFY_TRIES; i++) {
      const c = await classify(ctx.model, req, signal);
      if (c.kind === 'unavailable' || c.kind === 'cancelled') return c;
      if (c.kind === 'classified') return { domain: c.domain, routing: { by: 'classifier', confidence: c.confidence, reason: c.reason } };
      detail = c.detail;
    }
    return { domain: config.fallbackDomain, routing: { by: 'fallback', reason: detail } };
  }

  return {
    accept(input) {
      if (input.attachments.length) return Promise.resolve({ kind: 'photos-unsupported' });
      return ctx.memoLane(async () => {
        const path = memoFile.inbox(input.id);
        const wrote = await fs.create(path, renderMemoFile({ ...input, attachments: [] }, null));
        const c = await ctx.config();
        const at = c.ok ? locate(await places(c.config), input.id) : null;
        if (at) {
          if (wrote === 'created') await fs.remove(path);
          return { kind: 'duplicate', at };
        }
        return wrote === 'created' ? { kind: 'created' } : { kind: 'duplicate', at: 'inbox' };
      });
    },

    routeNext(signal) {
      return ctx.router(async () => {
        const c = await ctx.config();
        if (!c.ok) return { kind: 'paused', problems: c.problems };
        const picked = await ctx.memoLane(() => pickNext(c.config));
        if ('kind' in picked) return picked;
        const d = await decide(c.config, picked, signal);
        if (!('domain' in d)) return d.kind === 'cancelled' ? d : { kind: 'unavailable', unavailable: d };
        const held = d.routing.by === 'fallback' || (d.routing.by === 'classifier' && d.routing.confidence < HOLD_BELOW);
        const to = held ? memoFile.hold(d.domain, picked.id) : memoFile.raw(d.domain, picked.id);
        await ctx.memoLane(() => relocate(fs, memoFile.inbox(picked.id), to, renderMemoFile(picked, d.routing)));
        return { kind: held ? 'held' : 'routed', id: picked.id, domain: d.domain, routing: d.routing };
      });
    },

    async locate(id) {
      const c = await ctx.config();
      if (!c.ok) return null;
      const p = await places(c.config);
      return locate(p, id) ?? (p.inbox.has(id) ? 'inbox' : null);
    },
  };
}
