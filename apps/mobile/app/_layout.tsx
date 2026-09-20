import { Component, useEffect, useState, type ReactNode } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { Stack, router } from 'expo-router';

/**
 * The shell: show what went wrong, then decide where to start.
 *
 * The error boundary is first because of how this app failed on a real phone:
 * `[runtime not ready]: TypeError: Object is not a function`, with no file, no
 * line and no stack. That happens when something throws while modules are
 * still being evaluated — before React exists, so nothing can catch it and
 * nothing can be shown.
 *
 * Two changes stop that. Nothing heavy is imported at the top of this file, so
 * the entry graph stays trivial; and the app's wiring is built on first use
 * rather than at import. A failure then lands inside this boundary, on screen,
 * with a message and a stack.
 */
interface BoundaryState { error: Error | null }

class ErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <ScrollView style={styles.page} contentContainerStyle={styles.pageInner}>
        <Text style={styles.title}>This screen could not start</Text>
        <Text style={styles.message}>{error.message}</Text>
        {error.stack ? <Text style={styles.stack}>{error.stack}</Text> : null}
      </ScrollView>
    );
  }
}

function Gate() {
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    // Imported here, not at the top of the file: anything this module does on
    // load now happens after React is running, so a failure is catchable.
    let cancelled = false;
    void (async () => {
      try {
        const session = await import('@/lib/session.ts');
        session.onSignedOut(() => router.replace('/sign-in'));
        const tokens = await session.tokenStore().read();
        if (!cancelled && !tokens) router.replace('/sign-in');
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (!cancelled) setChecked(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (error) throw error;
  if (!checked) return <View style={styles.page} />;

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#0F172A' },
        headerTintColor: '#fff',
        headerTitleStyle: { fontWeight: '600' },
        contentStyle: { backgroundColor: '#F8FAFC' },
      }}
    >
      <Stack.Screen name="sign-in" options={{ title: 'paathshalaOS' }} />
      <Stack.Screen name="index" options={{ title: 'Attendance' }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <ErrorBoundary>
      <Gate />
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#F8FAFC' },
  pageInner: { padding: 20, paddingTop: 60 },
  title: { fontSize: 18, fontWeight: '700', color: '#B91C1C', marginBottom: 10 },
  message: { fontSize: 15, color: '#0F172A', marginBottom: 14 },
  stack: { fontSize: 11, color: '#334155', fontFamily: 'Courier' },
});
