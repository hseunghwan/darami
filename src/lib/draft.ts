/**
 * The memo tab's draft, as a reducer, so the rules a kill or a slow accept must not break are pure.
 * Its id is the memo's id: sending again after an accept cut off fills the same inbox file rather
 * than filing a second memo.
 */

export type Draft = { readonly id: string; readonly text: string; readonly hint: string | null };

export type DraftEvent =
  | { readonly kind: 'typed'; readonly text: string }
  | { readonly kind: 'hinted'; readonly hint: string | null }
  /** The copy kept from the last launch arrived. Anything typed meanwhile wins. */
  | { readonly kind: 'restored'; readonly saved: Draft | null }
  /** accept answered for `id`, or the book already holds it: a new draft, the chip kept. */
  | { readonly kind: 'filed'; readonly id: string; readonly next: string };

export function draftAfter(d: Draft, e: DraftEvent): Draft {
  switch (e.kind) {
    case 'typed':
      return { ...d, text: e.text };
    case 'hinted':
      return { ...d, hint: e.hint };
    case 'restored':
      return e.saved && d.text === '' ? e.saved : d;
    case 'filed':
      return e.id === d.id ? { id: e.next, text: '', hint: d.hint } : d;
  }
}

/** What kv keeps for the draft: null removes it. */
export const savedDraft = (d: Draft): string | null => (d.text.trim() === '' ? null : JSON.stringify(d));

export function parseSavedDraft(text: string | null): Draft | null {
  try {
    const v = text ? (JSON.parse(text) as Partial<Draft>) : null;
    if (!v || typeof v.id !== 'string' || v.id === '' || typeof v.text !== 'string') return null;
    return { id: v.id, text: v.text, hint: typeof v.hint === 'string' ? v.hint : null };
  } catch {
    return null;
  }
}
