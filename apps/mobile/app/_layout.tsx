import { useEffect, useState } from 'react';
import { Stack, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { onSignedOut, tokenStore } from '@/lib/session.ts';
import { theme } from '@/lib/theme.ts';

/**
 * The shell: decide where to start, and handle a session ending mid-screen.
 *
 * Nothing else. Screens are kept thin throughout this app because none of them
 * can be verified from a container — the logic they call into lives in shared
 * packages with their own suites, and the less that sits here the less there is
 * that only a device can check.
 */
export default function RootLayout() {
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    onSignedOut(() => router.replace('/sign-in'));
    tokenStore.read()
      .then((tokens) => {
        if (!tokens) router.replace('/sign-in');
      })
      .finally(() => setChecked(true));
  }, []);

  if (!checked) return null;

  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.navy },
          headerTintColor: '#fff',
          headerTitleStyle: { fontWeight: '600' },
          contentStyle: { backgroundColor: theme.background },
        }}
      >
        <Stack.Screen name="sign-in" options={{ title: 'paathshalaOS' }} />
        <Stack.Screen name="index" options={{ title: 'Attendance' }} />
      </Stack>
    </>
  );
}
