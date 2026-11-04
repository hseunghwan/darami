/**
 * The vocabulary more than one engine module names and no one module owns. Imports nothing. A
 * record with one owner lives with the module that parses and renders it.
 */

/** A domain declared in dotoriwiki.yaml. NFC. Minted only by parseWikiConfig. */
export type DomainName = string & { readonly __brand: 'DomainName' };
/** Client-made ULID or UUID, normalized. Minted only by parseMemoId / parseAnswerId. */
export type MemoId = string & { readonly __brand: 'MemoId' };
export type AnswerId = string & { readonly __brand: 'AnswerId' };

/** What a chat asks: every domain at once, or one. dotoriwiki's ChatTarget. */
export type ChatTarget = { readonly kind: 'root' } | { readonly kind: 'domain'; readonly domain: DomainName };

export const LOCALES = ['ko', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export type GeoPoint = { readonly lat: number; readonly lon: number; readonly place: string | null; readonly address: string | null };

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly detail: string };
