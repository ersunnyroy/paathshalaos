import { useEffect, useState } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator, Image,
} from 'react-native';
import { router } from 'expo-router';
import { theme } from '@/lib/theme.ts';

/*
 * Nothing that touches a native module is imported at the top of this file.
 *
 * expo-router evaluates EVERY file under `app/` at startup, to build its route
 * tree. So an import here is an import during module initialisation, before
 * React exists — and a module that throws there kills the app with
 * `[runtime not ready]` and no stack, outside the reach of any error boundary.
 * The session module is loaded inside effects and handlers instead.
 */
export default function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [where, setWhere] = useState<
    { api: string; tenant: string; name: string | null; logoUrl: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const session = await import('@/lib/session.ts');
        const school = session.currentSchool();
        if (!cancelled) {
          setWhere({
            api: session.apiUrl(),
            tenant: session.tenantId(),
            name: school?.name ?? null,
            logoUrl: school?.logoUrl ?? null,
          });
        }
      } catch (e) {
        // Thrown into the boundary on the next render, where it is legible.
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const session = await import('@/lib/session.ts');
      await session.signIn(email.trim(), password);
      router.replace('/');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.page}>
      {/* The supplied artwork, not a redrawn mark. `resizeMode="contain"` with
          a fixed height keeps the aspect ratio at any screen width; the asset
          is 800x198, so the width follows. */}
      {/* The school's own mark when they have one, ours when they have not.
          A white-labelled product that shows the vendor's logo on the sign-in
          screen is not white-labelled. */}
      <Image
        source={where?.logoUrl ? { uri: where.logoUrl } : require('../assets/logo.png')}
        style={styles.logo}
        resizeMode="contain"
        accessibilityRole="image"
        accessibilityLabel={where?.name ?? 'paathshalaOS'}
      />
      <Text style={styles.title}>{where?.name ?? 'Sign in'}</Text>
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
      {where && !where.tenant ? (
        <Text style={styles.error}>
          This phone is not set up for a school yet.
        </Text>
      ) : null}

      <Pressable
        style={[styles.button, busy && styles.buttonBusy]}
        onPress={submit}
        disabled={busy || !email || !password}
      >
        {busy
          ? <ActivityIndicator color="#fff" />
          : <Text style={styles.buttonText}>Sign in</Text>}
      </Pressable>

      {/* Always shown: "which machine is this talking to" is the first question
          when a request fails and the hardest to answer from a phone. */}
      <Pressable onPress={() => router.replace('/school')}>
        <Text style={styles.hint}>
          Not your school? Change it
        </Text>
      </Pressable>

      {/* Not a setting. A school can put its own name on this; it cannot claim
          to have built it. */}
      <Text style={styles.poweredBy}>Powered by paathshalaOS</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, padding: 24, justifyContent: 'center' },
  logo: { width: '70%', height: 54, alignSelf: 'flex-start', marginBottom: 22 },
  title: { fontSize: 24, fontWeight: '700', color: theme.navy },
  lede: { marginTop: 8, marginBottom: 20, color: theme.slate, lineHeight: 20 },
  label: { marginTop: 14, marginBottom: 6, fontWeight: '600', color: theme.slate },
  input: {
    borderWidth: 1, borderColor: theme.line, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 12, backgroundColor: '#fff',
    fontSize: 16,
  },
  error: { marginTop: 14, color: theme.critical },
  button: {
    marginTop: 24, backgroundColor: theme.teal, borderRadius: 10,
    paddingVertical: 14, alignItems: 'center',
  },
  buttonBusy: { opacity: 0.7 },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  hint: { marginTop: 16, fontSize: 13, color: theme.teal, textAlign: 'center' },
  poweredBy: {
    marginTop: 18, fontSize: 11.5, color: theme.slate, textAlign: 'center', opacity: 0.8,
  },
});
