/**
 * Every move of a memo file: accept, route, hold, confirm, move, retry, and the sweep that finishes
 * a move a kill cut off. dotoriwiki moved memos with link() and rename(),
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
import { locate, orderKey, type Located, type Places } from '../core/places';
import { textFor } from '../core/text';
import type { DomainName, MemoId } from '../core/types';
import { readPlaces } from '../core/wiki';
import { classify, type Unavailable } from '../agent/model';
import type { Ctx, Engine, HeldMemo, ReleaseResult, RouteReport } from './engine';

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

export function memoTransitions(ctx: Ctx): Pick<Engine, 'accept' | 'routeNext' | 'held' | 'confirm' | 'move' | 'retry' | 'locate'> & { readonly finishMoves: (d: DomainName) => Promise<void> } {
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

  /** The domain a move of this gave-up memo out of `from` already copied it into. */
  async function movedTo(config: WikiConfig, from: DomainName, id: MemoId): Promise<DomainName | null> {
    for (const d of config.domains.keys()) {
      if (d === from) continue;
      const parsed = parseMemoFile((await fs.readText(memoFile.raw(d, id))) ?? '');
      if (parsed.ok && parsed.value.routing?.by === 'user' && parsed.value.routing.from === from) return d;
    }
    return null;
  }

  /** A memo's files in d, the memo file last: while it is there, finishMoves knows the rest is still to go. */
  async function removeMemo(d: DomainName, id: MemoId): Promise<void> {
    await fs.remove(memoFile.source(d, id));
    await fs.remove(memoFile.raw(d, id));
  }

  /** The end of a gave-up memo's stay in `from`: the moved line, then its files. The line comes first, so a kill between leaves what finishMoves reads. */
  async function closeMove(from: DomainName, to: DomainName, id: MemoId): Promise<void> {
    await ctx.journal.appendLine(from, (l) => (l.history('ingest', id).terminal?.kind === 'gave-up' ? { job: 'ingest', id, outcome: { kind: 'moved', to } } : null));
    await removeMemo(from, id);
  }

  /** True when a whole copy of the memo is somewhere other than <d>/raw/: the source of a copy into d that a kill cut off. */
  async function wholeElsewhere(p: Places, d: DomainName, id: MemoId): Promise<boolean> {
    if (p.inbox.has(id) && isMemo(await fs.readText(memoFile.inbox(id)), id)) return true;
    for (const x of p.domains) {
      if (x.hold.has(id) && isMemo(await fs.readText(memoFile.hold(x.domain, id)), id)) return true;
      if (x.domain !== d && x.raw.has(id) && isMemo(await fs.readText(memoFile.raw(x.domain, id)), id)) return true;
    }
    return false;
  }

  /** A held or failed memo, read where locate() put it. */
  async function release(id: MemoId, ok: (at: Located) => boolean, act: (config: WikiConfig, at: Located, file: { readonly text: string; readonly memo: Memo; readonly routing: Routing | null }) => Promise<ReleaseResult>): Promise<ReleaseResult> {
    return ctx.memoLane(async () => {
      const c = await ctx.config();
      if (!c.ok) return { kind: 'paused' };
      const at = locate(await places(c.config), id);
      if (!at) return { kind: 'not-found' };
      if (!ok(at)) return { kind: 'conflict', at };
      const text = (await fs.readText(at.state === 'held' ? memoFile.hold(at.domain, id) : memoFile.raw(at.domain, id))) ?? '';
      const parsed = parseMemoFile(text);
      if (!parsed.ok) return { kind: 'conflict', at };
      return act(c.config, at, { text, ...parsed.value });
    });
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

    held() {
      return ctx.memoLane(async () => {
        const c = await ctx.config();
        if (!c.ok) return [];
        const p = await places(c.config);
        const out: HeldMemo[] = [];
        for (const { domain, hold } of p.domains) {
          for (const id of hold) {
            const file = memoFile.hold(domain, id);
            const parsed = parseMemoFile((await fs.readText(file)) ?? '');
            const at = locate(p, id);
            if (at && at.state !== 'held') {
              const raw = memoFile.raw(at.domain, id);
              if (isMemo(await fs.readText(raw), id)) {
                await fs.remove(file);
                continue;
              }
              // A confirm or move cut off before its copy was whole: this hold copy is the memo.
              if (at.state !== 'routed' || !parsed.ok) continue;
              await fs.remove(raw);
            }
            if (!parsed.ok || !parsed.value.routing) continue;
            const { memo, routing } = parsed.value;
            out.push({ id, domain, text: memo.text, capturedAt: memo.capturedAt, source: memo.source, routing });
          }
        }
        return out.sort((a, b) => (orderKey(a.capturedAt, a.id) < orderKey(b.capturedAt, b.id) ? -1 : 1));
      });
    },

    confirm(id) {
      return release(id, (at) => at.state === 'held', async (_config, at, file) => {
        await relocate(fs, memoFile.hold(at.domain, id), memoFile.raw(at.domain, id), file.text);
        return { kind: 'released', domain: at.domain };
      });
    },

    move(id, to) {
      return release(id, (at) => at.domain !== to && (at.state === 'held' || at.state === 'failed'), async (config, at, { memo, routing }) => {
        if (!config.domains.has(to)) return { kind: 'not-found' };
        const from = at.domain;
        // A domain the memo once left has a terminal line for it, so a retry line comes first or the new copy would never be picked.
        await ctx.journal.appendLine(to, (l) => (l.history('ingest', id).terminal ? { job: 'ingest', id, outcome: { kind: 'retry' } } : null));
        const moved = renderMemoFile(memo, { by: 'user', from, previous: routing });
        if (at.state === 'held') {
          await relocate(fs, memoFile.hold(from, id), memoFile.raw(to, id), moved);
          return { kind: 'released', domain: to };
        }
        const sidecar = await fs.readText(memoFile.source(from, id));
        // The sidecar first, so the copy in `to` is never fetched again.
        if (sidecar !== null) await copyWhole(fs, memoFile.source(to, id), sidecar);
        await copyWhole(fs, memoFile.raw(to, id), moved);
        await closeMove(from, to, id);
        return { kind: 'released', domain: to };
      });
    },

    async retry(d, id) {
      const c = await ctx.config();
      if (!c.ok || (await movedTo(c.config, d, id))) return 'not-failed';
      const wrote = await ctx.journal.appendLine(d, (l) => (l.history('ingest', id).terminal?.kind === 'gave-up' ? { job: 'ingest', id, outcome: { kind: 'retry' } } : null));
      return wrote ? 'retrying' : 'not-failed';
    },

    /**
     * What a kill cut off in <d>/raw/: a gave-up memo whose copy another domain holds with
     * `by: user, from: d` gets its moved line; a raw copy whose moved line is already there goes;
     * and a copy into d that does not parse goes while a whole copy of the memo is elsewhere.
     */
    finishMoves(d) {
      return ctx.memoLane(async () => {
        const c = await ctx.config();
        if (!c.ok) return;
        const p = await places(c.config);
        const here = p.domains.find((x) => x.domain === d);
        for (const id of here?.raw ?? []) {
          const t = here!.ledger.history('ingest', id).terminal?.kind;
          const to = t === 'gave-up' ? await movedTo(c.config, d, id) : null;
          if (to) await closeMove(d, to, id);
          else if (t === 'moved') await removeMemo(d, id);
          else if (!t && !isMemo(await fs.readText(memoFile.raw(d, id)), id) && (await wholeElsewhere(p, d, id))) {
            await fs.remove(memoFile.raw(d, id));
          }
        }
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
