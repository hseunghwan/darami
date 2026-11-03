/**
 * runNext(d): a domain's next job, start to ledger line. dotoriwiki's runNext, #candidates, #check,
 * #commitJob, and #commitFailure, with git replaced by the journal and the CLI by the tool loop.
 */

import type { DomainConfig, WikiConfig } from '../core/config';
import { committedPages, dayIn, ingestInstructions } from '../core/filing';
import { paths, type WikiPath } from '../core/layout';
import type { Ledger, VerdictId } from '../core/ledger';
import {
  check, namesOf, pageMeta, parseAnswerId, parseAnswerStaging, parseMemoFile, parseMemoId, parsePageRef, renderAnswerPage, renderIndex, roleOf,
  type AnswerFiling, type PageRef, type Problem,
} from '../core/pages';
import { orderKey } from '../core/places';
import { textFor, type Text } from '../core/text';
import type { DomainName, MemoId } from '../core/types';
import { composeSystemPrompt, readLedger } from '../core/wiki';
import { runAgent } from '../agent/loop';
import type { Ctx, Engine, JobRef, RunReport } from './engine';
import { memoFile } from './memos';
import type { JobTx } from './transaction';
import { jobWorkspace } from './workspace';

type Candidate =
  | { readonly kind: 'file-answer'; readonly ref: JobRef; readonly order: string; readonly staging: WikiPath; readonly filing: AnswerFiling }
  | { readonly kind: 'ingest'; readonly ref: JobRef; readonly order: string; readonly id: MemoId };

const byOrder = (a: Candidate, b: Candidate) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0);
const under = (d: DomainName, files: readonly WikiPath[]) => files.map((f) => f.slice(`${paths.wiki(d)}/`.length));

export function domainJobs(ctx: Ctx, finishMoves: (d: DomainName) => Promise<void>): Pick<Engine, 'runNext'> & { readonly init: () => Promise<void> } {
  const { fs } = ctx;

  /** The pages and answers under wiki/ as they are now, for index.md. */
  async function indexOf(dc: DomainConfig, t: Text): Promise<string> {
    const pages = [];
    for (const f of await fs.listTree(paths.wiki(dc.name))) {
      const p = f.slice(`${paths.wiki(dc.name)}/`.length);
      const role = roleOf(p);
      if (role === 'page' || role === 'answer') pages.push(pageMeta(p, (await fs.readText(f)) ?? ''));
    }
    return renderIndex(dc.name, pages, dc.pageTypes.map((p) => p.type), t);
  }

  /** dotoriwiki's init(<d>): log.md and index.md where they are missing, never replaced. */
  async function ensureDomain(dc: DomainConfig, t: Text): Promise<void> {
    await fs.create(paths.log(dc.name), '# log\n');
    if (!(await fs.readText(paths.index(dc.name)))) await fs.create(paths.index(dc.name), await indexOf(dc, t));
  }

  /** Answers first (no model, and someone is waiting), then memos; each group oldest first. */
  async function candidates(config: WikiConfig, d: DomainName, ledger: Ledger): Promise<readonly Candidate[]> {
    const domains = [...config.domains.keys()];
    const answers: Candidate[] = [];
    for (const name of await fs.list(paths.answersInbox(d))) {
      const id = name.endsWith('.md') ? parseAnswerId(name.slice(0, -3)) : null;
      if (!id || `${id}.md` !== name) continue;
      const staging = `${paths.answersInbox(d)}/${name}` as WikiPath;
      const terminal = ledger.history('file-answer', id).terminal;
      // Filed, but the run stopped before it removed the staging.
      if (terminal?.kind === 'applied') await fs.remove(staging);
      if (terminal) continue;
      const s = parseAnswerStaging((await fs.readText(staging)) ?? '');
      if (!s) continue;
      const cited = s.cited.map((c) => parsePageRef(c, d, domains)).filter((r): r is PageRef => r !== null);
      const filing: AnswerFiling = { id, domain: d, question: s.question, answer: s.answer, cited, sessionId: s.sessionId, askedAt: s.askedAt };
      answers.push({ kind: 'file-answer', ref: { kind: 'file-answer', domain: d, id }, order: orderKey(s.askedAt, id), staging, filing });
    }
    const memos: Candidate[] = [];
    for (const name of await fs.list(paths.raw(d))) {
      const id = name.endsWith('.md') && !name.endsWith('.source.md') ? parseMemoId(name.slice(0, -3)) : null;
      if (!id || `${id}.md` !== name || ledger.history('ingest', id).terminal) continue;
      // A copy that does not parse is a write cut off part way; the router or the move that made it finishes it.
      const parsed = parseMemoFile((await fs.readText(memoFile.raw(d, id))) ?? '');
      if (parsed.ok) memos.push({ kind: 'ingest', ref: { kind: 'ingest', domain: d, id }, order: orderKey(parsed.value.memo.capturedAt, id), id });
    }
    return [...answers.sort(byOrder), ...memos.sort(byOrder)];
  }

  /** check() over what the job did, every input read again. */
  async function checkJob(config: WikiConfig, dc: DomainConfig, tx: JobTx, start: { readonly inputs: ReadonlyMap<WikiPath, string | null>; readonly reviewBefore: string | null }, outsideWrites: readonly string[]): Promise<readonly Problem[]> {
    const names = new Map<string, ReadonlySet<string>>();
    for (const o of config.domains.keys()) names.set(o, namesOf(under(o, await fs.listTree(paths.wiki(o)))));
    const modifiedInputs: string[] = [];
    for (const [p, text] of start.inputs) if ((await fs.readText(p)) !== text) modifiedInputs.push(p);
    const { changes, contents } = tx.changes();
    return check({
      domain: dc.name,
      changes,
      contents,
      reviewBefore: start.reviewBefore,
      names,
      allowedTypes: new Set([...dc.pageTypes.map((p) => p.type), 'answer']),
      outsideWrites,
      modifiedInputs,
      attachments: new Set(await fs.list(paths.attachments)),
    });
  }

  async function settle(dc: DomainConfig, t: Text, tx: JobTx, job: JobRef, problems: readonly Problem[], verdict: VerdictId | null): Promise<RunReport> {
    if (verdict && problems.length === 0) {
      // Before the applied line: a commit never lands without its record, and a record whose line never landed counts for nothing.
      if (job.kind === 'ingest') {
        const { changes, contents } = tx.changes();
        await ctx.book.recordCommit(dc.name, job.id as MemoId, committedPages(dc.name, changes, contents));
      }
      await tx.commit(verdict, await indexOf(dc, t));
      return { kind: 'committed', job, verdict };
    }
    return (await tx.fail(problems)) === 'gave-up' ? { kind: 'gave-up', job, problems } : { kind: 'retrying', job, attempt: tx.job.attempt, problems };
  }

  return {
    /** dotoriwiki's bootstrap: every declared domain gets its log.md and index.md when the wiki opens. */
    async init() {
      const c = await ctx.config();
      if (c.ok) for (const dc of c.config.domains.values()) await ensureDomain(dc, textFor(c.config.locale));
    },

    async runNext(d, opts) {
      const c = await ctx.config();
      if (!c.ok) return { kind: 'paused' };
      const config = c.config;
      const dc = config.domains.get(d);
      if (!dc) return { kind: 'idle' };
      return ctx.jobLane(d)(async () => {
        const t = textFor(config.locale);
        await ensureDomain(dc, t);
        await ctx.journal.recover(d);
        await finishMoves(d);
        const ledger = await readLedger(fs, d);
        const picked = (await candidates(config, d, ledger)).find((j) => opts.withModel || j.kind === 'file-answer');
        if (!picked) return { kind: 'idle' };
        const history = ledger.history(picked.ref.kind, picked.ref.id);
        const tx = await ctx.journal.beginJob(d, { kind: picked.ref.kind, id: picked.ref.id, attempt: history.attempts + 1 });
        ctx.onEvent({ kind: 'started', job: picked.ref, attempt: tx.job.attempt });
        try {
          const reviewBefore = await fs.readText(paths.review(d));
          const today = dayIn(config.timeZone, ctx.now());
          if (picked.kind === 'file-answer') {
            const existing = new Set(under(d, await fs.listTree(paths.wiki(d))));
            const page = renderAnswerPage(picked.filing, today, existing, t);
            await tx.write(`${paths.wiki(d)}/${page.pathUnderWiki}` as WikiPath, page.content);
            const report = await settle(dc, t, tx, picked.ref, await checkJob(config, dc, tx, { inputs: new Map(), reviewBefore }, []), 'saved');
            if (report.kind === 'committed') await fs.remove(picked.staging);
            return report;
          }
          const { id } = picked;
          const inputs = new Map<WikiPath, string | null>([[memoFile.raw(d, id), await fs.readText(memoFile.raw(d, id))]]);
          const source = await fs.readText(memoFile.source(d, id));
          if (source !== null) inputs.set(memoFile.source(d, id), source);
          const out = await runAgent(ctx.model, {
            profile: dc.modelProfile,
            instructions: ingestInstructions({ domainPrompt: await composeSystemPrompt(fs, paths.domainSchema(d)), domain: dc, date: today, t }),
            prompt: t.ingest.prompt({ id, hasSource: source !== null, photos: [], lastFailure: history.lastFailure?.reason ?? null }),
            nudge: t.ingest.nudge,
            workspace: jobWorkspace({ fs, tx, declared: [...config.domains.keys()], reviewBefore }),
            limits: ctx.limits,
            signal: opts.signal,
            now: () => ctx.now().getTime(),
          });
          if (out.kind === 'unavailable' || out.kind === 'cancelled') {
            await tx.abandon();
            return out.kind === 'cancelled' ? { kind: 'cancelled', job: picked.ref } : { kind: 'unavailable', job: picked.ref, unavailable: out };
          }
          const problems: readonly Problem[] =
            out.kind === 'failed' ? [{ rule: 'llm', path: '', detail: out.reason }] : await checkJob(config, dc, tx, { inputs, reviewBefore }, out.kind === 'refused' ? [out.path] : []);
          return await settle(dc, t, tx, picked.ref, problems, out.kind === 'finished' ? out.verdict : null);
        } finally {
          tx.release();
        }
      });
    },
  };
}

