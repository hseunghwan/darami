import type { ExpoConfig } from 'expo/config';

/**
 * The Android package id and launcher name. A build you install next to someone else's, or
 * publish, sets its own: DARAMI_APP_ID=com.example.notes DARAMI_APP_NAME=Notes.
 */
const id = process.env.DARAMI_APP_ID || 'dev.darami.app';
const name = process.env.DARAMI_APP_NAME || undefined;

if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(id)) {
  throw new Error(`DARAMI_APP_ID "${id}" is not an Android package id, such as com.example.notes`);
}

const config: ExpoConfig = {
  name: name ?? 'Darami',
  slug: 'darami',
  version: '0.1.1',
  orientation: 'portrait',
  scheme: 'darami',
  userInterfaceStyle: 'automatic',
  platforms: ['android'],
  // The default name has a Korean launcher label. A name you set is used as-is in every locale.
  locales: name ? undefined : { ko: { android: { app_name: '다람이' } } },
  android: {
    package: id,
    // Raise with every release so Android installs the new APK over the old one.
    versionCode: 2,
    adaptiveIcon: {
      backgroundColor: '#7559dd',
      foregroundImage: './assets/images/android-icon-foreground.png',
      monochromeImage: './assets/images/android-icon-foreground.png',
    },
    softwareKeyboardLayoutMode: 'resize',
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    'expo-router',
    ['expo-splash-screen', { backgroundColor: '#ffffff', image: './assets/images/splash-icon.png', imageWidth: 160, dark: { backgroundColor: '#1e1e1e' } }],
    ['expo-build-properties', { android: { usesCleartextTraffic: true } }],
    './plugins/with-release-signing',
    'expo-sqlite',
    'expo-location',
    ['expo-media-library', { savePhotosPermission: false, isAccessMediaLocationEnabled: true, granularPermissions: ['photo'] }],
    ['expo-image-picker', { photosPermission: false, microphonePermission: false }],
    'expo-secure-store',
    './plugins/with-capture-intents',
  ],
  experiments: { typedRoutes: true, reactCompiler: true },
};

export default config;
