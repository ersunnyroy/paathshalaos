import { useState } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator,
} from 'react-native';
import { router } from 'expo-router';
import { signIn, tenantId, apiUrl } from '@/lib/session.ts';
import { theme } from '@/lib/theme.ts';

export default function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await signIn(email.trim(), password);
      router.replace('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.page}>
      <Text style={styles.title}>Sign in</Text>
      <Text style={styles.lede}>
        Attendance works without a signal. Everything you mark is kept on this
        phone and sent when you are back.
      </Text>

      <Text style={styles.label}>Email</Text>
      <TextInput
        style={styles.input}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        autoComplete="username"
        textContentType="username"
      />

      <Text style={styles.label}>Password</Text>
      <TextInput
        style={styles.input}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {!tenantId() ? (
        <Text style={styles.error}>
          No school is configured yet. Put the tenant id the seed printed into
          `expo.extra.tenantId` in apps/mobile/app.json, then reload.
        </Text>
      ) : null}
      {/* Shown always, because "which machine is this app talking to" is the
          first question when a request fails and the hardest to answer from a
          phone. */}
      <Text style={styles.hint}>API: {apiUrl()}</Text>

      <Pressable
        style={[styles.button, busy && styles.buttonBusy]}
        onPress={submit}
        disabled={busy || !email || !password}
      >
        {busy
          ? <ActivityIndicator color="#fff" />
          : <Text style={styles.buttonText}>Sign in</Text>}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, padding: 24, justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: '700', color: theme.navy },
  lede: { marginTop: 8, marginBottom: 20, color: theme.slate, lineHeight: 20 },
  label: { marginTop: 14, marginBottom: 6, fontWeight: '600', color: theme.slate },
  input: {
    borderWidth: 1, borderColor: theme.line, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 12, backgroundColor: '#fff',
    fontSize: 16,
  },
  error: { marginTop: 14, color: theme.critical },
  hint: { marginTop: 10, fontSize: 12, color: theme.slate, textAlign: 'center' },
  button: {
    marginTop: 24, backgroundColor: theme.teal, borderRadius: 10,
    paddingVertical: 14, alignItems: 'center',
  },
  buttonBusy: { opacity: 0.7 },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});
