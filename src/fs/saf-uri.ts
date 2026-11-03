/**
 * SAF tree URIs as strings: which ones darami can use, and the document URI of a WikiPath under
 * one. Pure, so jest tests it; saf.ts does the I/O.
 *
 * expo-file-system's `new File(dir, name)` resolves every child of a SAF tree to the tree itself
 * (measured on the emulator), so darami builds each document URI itself:
 *
 *   content://com.android.externalstorage.documents/tree/primary%3ADocuments%2Fwiki
 *     /document/<encodeURIComponent('primary:Documents/wiki/' + path)>
 *
 * That works only where a document id is `<volume>:<path>`. ExternalStorageProvider's ids are;
 * Downloads (`msf:123`) and cloud providers use opaque ids, so their trees are refused at pick time
 * instead of failing on the first read.
 */

import type { WikiPath } from '../core/layout';
import type { Parsed } from '../core/types';

const AUTHORITY = 'com.android.externalstorage.documents';

/** A folder darami can open, and the folder under it an Fs is bound to. Minted only by parseSafTree and within. */
export type SafTree = {
  /** The granted tree, `content://…/tree/<id as the picker encoded it>`, no trailing slash. What kv stores. */
  readonly uri: string;
  /** The bound folder's document id: the tree's own (`primary:Documents/wiki`) or one under it. */
  readonly baseId: string;
  /** The bound folder's name, for the screen: `wiki`, or the volume for a volume root. */
  readonly name: string;
} & { readonly __brand: 'SafTree' };

export function parseSafTree(uri: string): Parsed<SafTree> {
  const m = /^content:\/\/([^/]+)\/tree\/([^/]+)\/?$/.exec(uri);
  if (!m) return { ok: false, detail: uri };
  const [, authority, segment] = m as unknown as [string, string, string];
  if (authority !== AUTHORITY) return { ok: false, detail: authority };
  let id: string;
  try {
    id = decodeURIComponent(segment);
  } catch {
    return { ok: false, detail: uri };
  }
  const v = /^([^:/]+):(.*)$/.exec(id);
  if (!v) return { ok: false, detail: id };
  const rest = v[2]!.replace(/\/+$/, '');
  const baseId = `${v[1]}:${rest}`;
  const name = rest === '' ? v[1]! : rest.slice(rest.lastIndexOf('/') + 1);
  return { ok: true, value: { uri: `content://${authority}/tree/${segment}`, baseId, name } as SafTree };
}

/** `''` is the bound folder itself. A volume root's id ends in `:` and takes no slash. */
export function documentId(tree: SafTree, path: WikiPath): string {
  if (path === '') return tree.baseId;
  return tree.baseId.endsWith(':') ? tree.baseId + path : `${tree.baseId}/${path}`;
}

/** The URI expo-file-system's File and Directory take for `path`. */
export function documentUri(tree: SafTree, path: WikiPath): string {
  return `${tree.uri}/document/${encodeURIComponent(documentId(tree, path))}`;
}

/** Where the picker opens: the bound folder, or Documents on the phone's own storage. */
export function initialUriOf(tree: SafTree | null): string {
  return `content://${AUTHORITY}/document/${encodeURIComponent(tree ? tree.baseId : 'primary:Documents')}`;
}

/** The same grant, bound to a folder under it. darami://fs-check gives each case its own. */
export function within(tree: SafTree, sub: WikiPath): SafTree {
  return { ...tree, baseId: documentId(tree, sub), name: sub.slice(sub.lastIndexOf('/') + 1) };
}
