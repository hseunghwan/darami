/**
 * A wiki folder read and set up through the Fs port. The only engine module that touches files;
 * every other module gets strings (boundary.test.ts).
 *
 * The config rule, from dotoriwiki's index.ts: every caller that needs the configuration reads
 * dotoriwiki.yaml, then checks that the CLAUDE.md files it needs exist. While that fails the wiki
 * is paused, and the caller shows the problems. The next read after a fix resumes.
 */

import { addedName, applyEdit, folded, type ConfigEdit, type EditRefusal, type RootEntry } from './config-edit';
import { CONFIG_FILE, parseWikiConfig, type ConfigParse, type ConfigProblem, type MachineFacts, type WikiConfig } from './config';
import { FolderUnreachable, type Fs } from './fs';
import { parseWikiPath, paths, resolvePath, ROOT, type WikiPath } from './layout';
import { parseLedger, type Ledger } from './ledger';
import { memoIdsIn, type Places } from './places';
import { presetFiles, unfinishedPreset } from './presets';
import type { DomainName, Locale } from './types';

/** The config rule's answer for a folder with no dotoriwiki.yaml at all. */
export const NO_CONFIG: Extract<ConfigParse, { readonly ok: false }> = { ok: false, problems: [{ key: CONFIG_FILE, problem: 'does not exist', fix: 'restore it, or pick the wiki folder again' }] };

/** null when the folder has no dotoriwiki.yaml. A missing CLAUDE.md is one of the problems. */
export async function readConfig(fs: Fs, machine: MachineFacts): Promise<ConfigParse | null> {
  const text = await fs.readText(paths.config);
  return text === null ? null : withSchemas(fs, parseWikiConfig(text, machine));
}

/** The config rule's second half: a config that parses still pauses while a CLAUDE.md it needs is missing. */
async function withSchemas(fs: Fs, parsed: ConfigParse): Promise<ConfigParse> {
  if (!parsed.ok) return parsed;
  const missing: ConfigProblem[] = [];
  if ((await fs.readText(paths.rootSchema)) === null) missing.push({ key: 'CLAUDE.md', problem: 'the root CLAUDE.md does not exist', fix: 'create it; the classifier reads it to route memos' });
  for (const d of parsed.config.domains.keys()) {
    if ((await fs.readText(paths.domainSchema(d))) === null) missing.push({ key: `domains.${d}`, problem: `${d}/CLAUDE.md does not exist`, fix: `create ${d}/CLAUDE.md, or remove the entry` });
  }
  return missing.length ? { ok: false, problems: [...missing, ...parsed.warnings] } : parsed;
}

/**
 * A CLAUDE.md with every whole-line `@relative/path` replaced by that file's content,
 * recursively. A target that is missing, outside the folder, or already being inlined above
 * keeps its line as written. Throws when `path` itself is missing.
 */
export async function composeSystemPrompt(fs: Pick<Fs, 'readText'>, path: WikiPath): Promise<string> {
  const text = await fs.readText(path);
  if (text === null) throw new Error(`${path} does not exist`);
  return inline(fs, path, text, new Set());
}

async function inline(fs: Pick<Fs, 'readText'>, path: WikiPath, text: string, seen: ReadonlySet<WikiPath>): Promise<string> {
  const dir = resolvePath(path, '..')!;
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^@(\S.*)$/.exec(line.trim());
    const target = m ? resolvePath(dir, m[1]!) : null;
    const inner = target && !seen.has(target) ? await fs.readText(target) : null;
    out.push(target && inner !== null ? (await inline(fs, target, inner, new Set([...seen, path]))).trimEnd() : line);
  }
  return out.join('\n');
}

/**
 * What a folder holds, as the app has to act on it. Derived from the folder on every call and never
 * stored, so an edit made in Obsidian shows on the next inspect. Dot names (.stfolder, .obsidian,
 * .trash, .gitignore) count for nothing here.
 */
export type FolderState =
  | { readonly kind: 'empty' }
  /** No config or an empty one, and only names a `locale` preset puts at the root: a copy that stopped part way. */
  | { readonly kind: 'unfinished'; readonly locale: Locale }
  | { readonly kind: 'wiki'; readonly config: WikiConfig; readonly warnings: readonly ConfigProblem[] }
  /** Paused until fixed, by the config rule above. */
  | { readonly kind: 'broken'; readonly problems: readonly ConfigProblem[] }
  /** Files that are neither a wiki nor a preset copy. `names` is the first few visible root names. */
  | { readonly kind: 'foreign'; readonly names: readonly string[] }
  | { readonly kind: 'unreachable' };

export type SetUp = { readonly locale: Locale; readonly zone: string | undefined; readonly machine: MachineFacts; readonly intent: ConfigIntent };

const FOREIGN_SHOWN = 3;

/** `preferred` picks the locale when a cut-off copy fits both presets. A config write a kill cut off is settled first. */
export async function inspectFolder(fs: Fs, machine: MachineFacts, preferred: Locale, intent: ConfigIntent): Promise<FolderState> {
  try {
    await settleConfigWrite(fs, intent);
    const visible = (await fs.list(ROOT)).filter((n) => !n.startsWith('.'));
    if (visible.length === 0) return { kind: 'empty' };
    const text = await fs.readText(paths.config);
    // An empty config is what a copy killed between making the file and writing it leaves.
    if (text === null || text === '') {
      const locale = unfinishedPreset(visible, preferred);
      return locale ? { kind: 'unfinished', locale } : { kind: 'foreign', names: visible.slice(0, FOREIGN_SHOWN) };
    }
    const parsed = await withSchemas(fs, parseWikiConfig(text, machine));
    return parsed.ok ? { kind: 'wiki', config: parsed.config, warnings: parsed.warnings } : { kind: 'broken', problems: parsed.problems };
  } catch (e) {
    if (e instanceof FolderUnreachable) return { kind: 'unreachable' };
    throw e;
  }
}

/**
 * Writes the preset into an empty folder, or finishes a cut-off copy in that copy's locale, and
 * answers the folder's new state. Any other folder is answered as it is and not written to.
 *
 * Idempotent: every write is create, which never replaces text and fills an empty file, so a rerun
 * after a kill at any point writes exactly what is still missing. A kill inside one file's single
 * write can leave a prefix that a rerun keeps; for dotoriwiki.yaml that reads as broken.
 */
export async function setUpWiki(fs: Fs, setUp: SetUp): Promise<FolderState> {
  const before = await inspectFolder(fs, setUp.machine, setUp.locale, setUp.intent);
  const locale = before.kind === 'empty' ? setUp.locale : before.kind === 'unfinished' ? before.locale : null;
  if (locale === null) return before;
  try {
    // One at a time: the order is what keeps a cut-off copy from reading as a wiki.
    for (const f of presetFiles(locale, setUp.zone)) await fs.create(f.path, f.text);
  } catch (e) {
    if (e instanceof FolderUnreachable) return { kind: 'unreachable' };
    throw e;
  }
  return inspectFolder(fs, setUp.machine, setUp.locale, setUp.intent);
}

/**
 * The config text being written, held outside the folder until the write ends: Fs.write truncates
 * and then writes, so a kill between the two would leave dotoriwiki.yaml cut short, and Syncthing
 * would carry it on. kv on the phone (SQLite, synchronous FULL), memory under jest. One per folder.
 */
export type ConfigIntent = {
  get(): Promise<string | null>;
  set(text: string): Promise<void>;
  clear(): Promise<void>;
};

export type ConfigEditResult =
  | { readonly kind: 'saved'; readonly config: WikiConfig }
  | { readonly kind: 'same'; readonly config: WikiConfig }
  | { readonly kind: 'refused'; readonly refusal: EditRefusal };

/**
 * One domain edit against the folder as it is now (config-edit.ts says what it may change). Writes
 * nothing on same or refused. Otherwise a new domain's CLAUDE.md is made first, so the yaml never
 * names a domain without one, and dotoriwiki.yaml is written last under the intent. Throws
 * FolderUnreachable as every Fs call does.
 */
export async function saveConfigEdit(fs: Fs, intent: ConfigIntent, machine: MachineFacts, edit: ConfigEdit): Promise<ConfigEditResult> {
  const text = await fs.readText(paths.config);
  if (text === null) return { kind: 'refused', refusal: { kind: 'broken', problems: NO_CONFIG.problems } };
  const now = await withSchemas(fs, parseWikiConfig(text, machine));
  if (!now.ok) return { kind: 'refused', refusal: { kind: 'broken', problems: now.problems } };
  const r = applyEdit(text, edit, { machine, sameNameAtRoot: edit.kind === 'add' ? await rootEntryFor(fs, edit.name) : null });
  if (r.kind !== 'changed') return r;
  if (r.schema) {
    const path = paths.domainSchema(r.schema.name);
    // A create a kill cut off leaves a prefix of the text; any other text is the user's and stays.
    if ((await fs.create(path, r.schema.text)) === 'exists' && cutOff(await fs.readBytes(path), r.schema.text)) await fs.write(path, r.schema.text);
  }
  await intent.set(r.text);
  await fs.write(paths.config, r.text);
  await intent.clear();
  return { kind: 'saved', config: r.config };
}

/** The root entry a new domain's name would land on once case and Unicode form are folded, as Android's storage compares names. */
export async function rootEntryFor(fs: Fs, typed: string): Promise<RootEntry | null> {
  const name = folded(addedName(typed));
  const hit = (await fs.list(ROOT)).find((n) => folded(n) === name);
  if (hit === undefined) return null;
  const path = parseWikiPath(hit);
  const folder =
    path !== null &&
    (await fs.list(path).then(
      () => true,
      (e: unknown) => {
        if (e instanceof FolderUnreachable) throw e;
        return false;
      },
    ));
  return { name: hit, folder };
}

/**
 * Finishes or forgets a config write a kill cut off:
 *   no intent                                              nothing
 *   the file is empty or a strict prefix of the            the write was cut: finish it
 *   intended text's bytes (a cut can split a character)
 *   anything else, a missing file included                 it ended, or another app wrote since
 * and then the intent goes. A kill inside this leaves a prefix again, which the next inspect settles.
 */
async function settleConfigWrite(fs: Fs, intent: ConfigIntent): Promise<void> {
  const intended = await intent.get();
  if (intended === null) return;
  if (cutOff(await fs.readBytes(paths.config), intended)) await fs.write(paths.config, intended);
  await intent.clear();
}

function cutOff(bytes: Uint8Array | null, text: string): boolean {
  const whole = new TextEncoder().encode(text);
  return bytes !== null && bytes.length < whole.length && bytes.every((b, i) => b === whole[i]);
}

/** <d>/wiki/log.md parsed; a missing file is an empty ledger. */
export async function readLedger(fs: Pick<Fs, 'readText'>, d: DomainName): Promise<Ledger> {
  return parseLedger((await fs.readText(paths.log(d))) ?? '');
}

/**
 * Where memos are, read fresh: the inbox, and each declared domain's raw/, hold/, and log.md. Never
 * cached, because Obsidian and Syncthing change the same folder.
 */
export async function readPlaces(fs: Fs, config: WikiConfig, running: Places['running']): Promise<Places> {
  const domains = [];
  for (const d of config.domains.keys()) {
    domains.push({ domain: d, raw: memoIdsIn(await fs.list(paths.raw(d))), hold: memoIdsIn(await fs.list(paths.hold(d))), ledger: await readLedger(fs, d) });
  }
  return { inbox: memoIdsIn(await fs.list(paths.inbox)), domains, running };
}
