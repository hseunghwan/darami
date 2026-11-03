import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FS_CASES, type Seed } from '../contract';
import { nodeFs } from '../node';

function seedAt(root: string): Seed {
  const on = (rel: string) => join(root, ...rel.split('/'));
  return {
    async file(rel, text) {
      mkdirSync(dirname(on(rel)), { recursive: true });
      writeFileSync(on(rel), Buffer.from(text, 'utf8'));
    },
    async folder(rel) {
      mkdirSync(on(rel), { recursive: true });
    },
    async dropRoot() {
      rmSync(root, { recursive: true });
    },
  };
}

test.each(FS_CASES.map((c) => [c.name, c] as const))('%s', async (_, c) => {
  const root = mkdtempSync(join(tmpdir(), 'darami-nodefs-'));
  await c.run(nodeFs(root), seedAt(root));
});
