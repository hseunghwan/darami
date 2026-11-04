import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { boot, useApp } from '../state';
import { useTheme } from '../ui/theme';

/** A deep link straight to a sheet still has the tabs underneath it. */
export const unstable_settings = { initialRouteName: '(tabs)' };

export default function RootLayout() {
  const ready = useApp((a) => a.ready);
  const t = useTheme();
  useEffect(() => {
    void boot();
  }, []);
  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(t.bg);
  }, [t.bg]);

  if (!ready) return <View style={{ flex: 1, backgroundColor: t.bg }} />;
  return (
    <SafeAreaProvider>
      <StatusBar style={t.scheme === 'dark' ? 'light' : 'dark'} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg }, animation: 'fade' }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="onboarding" />
        <Stack.Screen name="settings" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="memo/[id]" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="chats" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="page" options={{ animation: 'slide_from_right' }} />
        <Stack.Screen name="move/[id]" options={{ presentation: 'transparentModal', animation: 'fade', contentStyle: { backgroundColor: 'transparent' } }} />
        <Stack.Screen name="model/[role]" options={{ presentation: 'transparentModal', animation: 'fade', contentStyle: { backgroundColor: 'transparent' } }} />
        <Stack.Screen name="compose" options={{ presentation: 'transparentModal', animation: 'fade', contentStyle: { backgroundColor: 'transparent' } }} />
      </Stack>
    </SafeAreaProvider>
  );
}
