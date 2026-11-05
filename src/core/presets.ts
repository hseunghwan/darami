/**
 * The preset wikis as darami writes them: dotoriwiki's copyPreset and setTimeZone (src/init.ts)
 * minus the disk. Pure; wiki.ts does the writing.
 *
 * presets/ stays the source of truth. presets.gen.ts is that folder as string constants, made by
 * scripts/presets.ts and held to it byte for byte by __tests__/presets.test.ts.
 */

import { parseWikiConfig } from './config';
import { parseWikiPath, paths, type WikiPath } from './layout';
import { validTz } from './pages';
import { PRESET_SOURCE } from './presets.gen';
import { LOCALES, type DomainName, type Locale } from './types';

export type PresetFile = { readonly path: WikiPath; readonly text: string };

/** npm pack leaves out every .gitignore, so a preset keeps its own as `gitignore`. */
const onDisk = (sourcePath: string) => (sourcePath === 'gitignore' ? '.gitignore' : sourcePath);

function mustPath(p: string): WikiPath {
  const w = parseWikiPath(p);
  if (w === null || w === '') throw new Error(`presets/ holds a path the wiki cannot: ${JSON.stringify(p)}`);
  return w;
}

/**
 * Every file of `locale`'s preset as it lands in the wiki folder, in write order: sorted by path,
 * with dotoriwiki.yaml last, so a copy cut off part way has no config and never reads as a wiki.
 */
export function presetFiles(locale: Locale, zone: string | undefined): readonly PresetFile[] {
  const files = Object.entries(PRESET_SOURCE[locale])
    .map(([p, text]) => ({ path: mustPath(onDisk(p)), text }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const config = files.find((f) => f.path === paths.config)!;
  return [...files.filter((f) => f !== config), { path: config.path, text: withZone(config.text, zone) }];
}

/**
 * The preset config with its `time_zone:` line set to `zone`, unless `zone` is missing, not a zone
 * Intl knows, or would make the file stop parsing; then the preset's own zone stays.
 */
export function withZone(presetConfig: string, zone: string | undefined): string {
  if (!zone || /\s/.test(zone) || !validTz(zone)) return presetConfig;
  const text = presetConfig.replace(/^time_zone: .*$/m, `time_zone: ${zone}`);
  return parseWikiConfig(text, { modelProfiles: new Set() }).ok ? text : presetConfig;
}

/**
 * `<name>/CLAUDE.md` for a domain added in the app: the title, the `@../_schema/…` line, and the
 * purpose heading the locale's preset domains open with, then the description. Both lines are read
 * from the first preset domain, and presets.test.ts holds every preset domain to the same opening.
 */
export function newDomainSchema(locale: Locale, name: DomainName, description: string): string {
  const [, sample] = Object.entries(PRESET_SOURCE[locale]).find(([p]) => /^[^_/][^/]*\/CLAUDE\.md$/.test(p))!;
  const [, , include, , heading] = sample.split('\n');
  return `# ${name}\n\n${include}\n\n${heading}\n\n${description}\n`;
}

/** The visible names a preset puts at the folder root, dotoriwiki.yaml included. */
function rootNames(locale: Locale): ReadonlySet<string> {
  return new Set(Object.keys(PRESET_SOURCE[locale]).map((p) => onDisk(p).split('/')[0]!).filter((n) => !n.startsWith('.')));
}

/**
 * The locale of a preset copy that stopped part way, given the visible root names of a folder with
 * no config or an empty one; null when some name belongs to no preset. `preferred` wins a tie.
 * A wrong guess costs little: create never replaces text.
 */
export function unfinishedPreset(visible: readonly string[], preferred: Locale): Locale | null {
  const fits = (l: Locale) => visible.every((n) => rootNames(l).has(n));
  return [preferred, ...LOCALES.filter((l) => l !== preferred)].find(fits) ?? null;
}
