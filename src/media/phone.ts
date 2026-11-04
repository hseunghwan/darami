/**
 * The PhotoTools port on the phone. Imported only by state.ts and app/photo-check.tsx, so
 * src/jobs never loads a native module (boundary.test.ts).
 *
 * expo-image-manipulator decodes through expo-image-loader, which is Glide: it applies EXIF
 * orientation while decoding, and the re-encode writes no EXIF, so the copy's pixels come out
 * upright with nothing left to undo. darami://photo-check proves it on a device.
 */

import * as Crypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat, type ImageRef } from 'expo-image-manipulator';
import { fitWithin, type PhotoTools } from '../core/photos';

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

export const phonePhotoTools: PhotoTools = {
  async sha256(bytes) {
    return hex(await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes as Uint8Array<ArrayBuffer>));
  },

  async jpeg(bytes, spec) {
    // A fresh name per call: the loader is told not to cache, and a reused name could still meet a stale decode.
    const src = new File(Paths.cache, `jpeg-in-${Crypto.randomUUID()}`);
    const refs: ImageRef[] = [];
    let out: File | null = null;
    try {
      await src.write(bytes);
      // Twice the cap bounds the decode's memory for a 50 MP photo; the exact cap is the resize below.
      const decoded = await ImageManipulator.manipulate(src.uri, { maxWidth: 2 * spec.maxEdge, maxHeight: 2 * spec.maxEdge }).renderAsync();
      refs.push(decoded);
      const fit = fitWithin(decoded.width, decoded.height, spec.maxEdge);
      const image = fit ? await ImageManipulator.manipulate(decoded).resize(fit).renderAsync() : decoded;
      if (image !== decoded) refs.push(image);
      const saved = await image.saveAsync({ compress: spec.quality, format: SaveFormat.JPEG });
      out = new File(saved.uri);
      return await out.bytes();
    } catch {
      // The loader's "Loading bitmap failed", and every other failure, reads as undecodable.
      return null;
    } finally {
      for (const r of refs) r.release();
      for (const f of [src, out]) if (f?.exists) f.delete();
    }
  },
};
