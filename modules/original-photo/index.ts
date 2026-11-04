import { requireNativeModule } from 'expo';

/** `uri` is a file:// URI under the app's files dir. `original` is false when MediaStore may have blanked the GPS tags. */
export type CopiedPhoto = { uri: string; original: boolean };

type OriginalPhotoModule = {
  /** Copies a MediaStore image's original bytes (by expo-media-library asset id) to `dir/name.<ext>`, never re-encoded. */
  copyAsset(id: string, dir: string, name: string): Promise<CopiedPhoto>;
};

export default requireNativeModule<OriginalPhotoModule>('OriginalPhoto');
