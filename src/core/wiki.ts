/**
 * A wiki folder read through the Fs port. The only engine module that touches files; every other
 * module gets strings (boundary.test.ts).
 *
 * The config rule, from dotoriwiki's index.ts: every caller that needs the configuration reads
 * dotoriwiki.yaml, then checks that the CLAUDE.md files it needs exist. While that fails the wiki
 * is paused, and the caller shows the problems. The next read after a fix resumes.
 */

import { parseWikiConfig, type ConfigParse, type ConfigProblem, type MachineFacts } from './config';
import type { Fs } from './fs';
import { paths, resolvePath, type WikiPath } from './layout';

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
export async function composeSystemPrompt(fs: Fs, path: WikiPath): Promise<string> {
  const text = await fs.readText(path);
  if (text === null) throw new Error(`${path} does not exist`);
  return inline(fs, path, text, new Set());
}

async function inline(fs: Fs, path: WikiPath, text: string, seen: ReadonlySet<WikiPath>): Promise<string> {
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
