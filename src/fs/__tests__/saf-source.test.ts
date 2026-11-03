/**
 * The SAF traps tsc cannot see, as rules on saf.ts's source text. Each was measured on the emulator;
 * saf.ts's header says what each one does.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The code without its comments, which name the traps they avoid. */
const SOURCE = readFileSync(join(__dirname, '..', 'saf.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** The top-level arguments of every call that `callee` (a regex source ending before the paren) starts. */
function calls(text: string, callee: string): { at: number; args: string[] }[] {
  return [...text.matchAll(new RegExp(`${callee}\\(`, 'g'))].map((m) => {
    const args: string[] = [];
    let depth = 0;
    let start = m.index + m[0].length;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if ((c === ',' && depth === 0) || ((c === ')' || c === ']' || c === '}') && depth-- === 0)) {
        args.push(text.slice(start, i).trim());
        if (c !== ',') break;
        start = i + 1;
      }
    }
    return { at: m.index, args: args.filter((a) => a !== '') };
  });
}

/** The span of `function name(`, at any indentation, through the brace that closes it at that indentation. */
function body(name: string): { from: number; to: number } {
  const m = new RegExp(`^( *)(?:async )?function ${name}\\(`, 'm').exec(SOURCE);
  assert.ok(m, name);
  const to = SOURCE.indexOf(`\n${m[1]}}\n`, m.index);
  assert.ok(to > m.index, name);
  return { from: m.index, to };
}

const inside = (c: { at: number }, ...names: string[]) => names.some((n) => {
  const b = body(n);
  return c.at > b.from && c.at < b.to;
});

test('the scanner sees the calls it checks', () => {
  assert.ok(calls(SOURCE, 'new File').length > 0);
  assert.ok(calls(SOURCE, 'new Directory').length > 0);
  assert.ok(calls(SOURCE, '\\.createFile').length > 0);
  assert.deepEqual(calls('f(a, g(b, c), [d, e])', 'f')[0]!.args, ['a', 'g(b, c)', '[d, e]']);
});

test('no File or Directory is built from two parts, which resolves to the tree itself on SAF', () => {
  const joined = [...calls(SOURCE, 'new File'), ...calls(SOURCE, 'new Directory')].filter((c) => c.args.length !== 1);
  assert.deepEqual(joined, []);
});

test('createFile always gets the MIME constant, since a null MIME turns a.md into a.md.txt', () => {
  assert.match(SOURCE, /^const MIME = 'application\/octet-stream';$/m);
  assert.deepEqual(calls(SOURCE, '\\.createFile').filter((c) => c.args[1] !== 'MIME'), []);
});

test('nothing calls write(), which does not truncate on SAF', () => {
  assert.deepEqual(calls(SOURCE, '\\.write'), []);
});

test('delete(), recursive on a SAF folder, is called only inside discardTwin and removeFile, which takes only a File', () => {
  const deletes = calls(SOURCE, '\\.delete');
  assert.equal(deletes.length, 2);
  assert.ok(deletes.every((c) => inside(c, 'discardTwin', 'removeFile')));
  assert.match(SOURCE, /^function removeFile\(file: File\): void \{$/m);
});

test('createFile is called only inside makeFile, so every new file gets the twin check', () => {
  const creates = calls(SOURCE, '\\.createFile');
  assert.equal(creates.length, 1);
  assert.ok(inside(creates[0]!, 'makeFile'));
});

test('open() is called only inside writeWhole, and always with FileMode.Truncate', () => {
  const opens = calls(SOURCE, '\\.open');
  assert.equal(opens.length, 1);
  assert.ok(inside(opens[0]!, 'writeWhole'));
  assert.deepEqual(opens[0]!.args, ['FileMode.Truncate']);
});
