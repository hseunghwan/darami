/** The pure helpers of dotoriwiki test/helpers.ts at 91f0aac. Not a test file: testMatch takes *.test.ts only. */

import { parseMemo, type NewMemo } from '../pages';

export function page(fields: Record<string, unknown>, body = '본문.\n'): string {
  const fm = Object.entries(fields).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`);
  return `---\n${fm.join('\n')}\n---\n${body}`;
}

export const validFields = (id: string, extra: Record<string, unknown> = {}) => ({
  type: 'concept', summary: `요약 ${id}`, aliases: [], status: 'active', sources: [id], updated: '2026-10-29', ...extra,
});

export const ulid = (n: number) => `01JB8ZQ4M3T9X7K2W5R6N8P${String(n).padStart(3, '0')}`;

export function memo(n: number, text = `메모 ${n}`, extra: Record<string, unknown> = {}): NewMemo {
  const r = parseMemo({ id: ulid(n), text, captured_at: `2026-10-29T08:${String(n % 60).padStart(2, '0')}:00+09:00`, tz: 'Asia/Seoul', source: 'typed', ...extra });
  if (!r.ok) throw new Error(r.detail);
  return r.value;
}
