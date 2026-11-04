import { Directory, File, Paths } from 'expo-file-system';

// Picked and shared photos wait in files/outbox/pending/, a path plugins/with-capture-intents.js
// hardcodes for CaptureActivity, until accept has stored them in the wiki folder.

export const pendingDir = () => new Directory(Paths.document, 'outbox', 'pending');

function ensure(dir: Directory): Directory {
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

export const pendingUri = (): string => ensure(pendingDir()).uri;

/** The camera's shot sits in the picker's cache, which the system may clear; keep our own copy. */
export async function keepCameraShot(uri: string, name: string): Promise<string> {
  const ext = /\.([a-z0-9]{1,5})$/i.exec(uri)?.[1]?.toLowerCase() ?? 'jpg';
  const shot = new File(uri);
  const dest = new File(ensure(pendingDir()), `${name}.${ext}`);
  await shot.move(dest);
  return dest.uri;
}

export function removeQuietly(uris: readonly string[]): void {
  for (const uri of uris) {
    try {
      const f = new File(uri);
      if (f.exists) f.delete();
    } catch {}
  }
}

/**
 * Photos a share sheet left when it was killed. Older than a day, so a sheet still open is safe, and
 * never one the memo tab's kept draft names (`keep`, by file name), which waits for its send.
 */
export function sweepPending(keep: ReadonlySet<string>, now = Date.now()): void {
  try {
    const dir = pendingDir();
    if (!dir.exists) return;
    for (const f of dir.list()) {
      if (f instanceof File && !keep.has(f.name) && (f.modificationTime ?? now) < now - 24 * 3_600_000) f.delete();
    }
  } catch {}
}

export const fileName = (uri: string): string => uri.slice(uri.lastIndexOf('/') + 1);
