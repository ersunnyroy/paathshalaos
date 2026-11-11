import { useState } from 'react';
import {
  View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator, Image,
} from 'react-native';
import { router } from 'expo-router';
import { theme } from '@/lib/theme.ts';

/*
 * First run: which school is this?
 *
 * The app used to carry a tenant id in app.json, which is one build per school
 * and means a teacher cannot install it from a store. They type the address
 * they already use in a browser, once, and the app resolves the rest.
 *
 * Nothing native is imported at the top of this file — expo-router evaluates
 * every route at startup, and an import here runs before React exists.
 */
export default function SchoolPicker() {
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<{ name: string; logoUrl: string | null } | null>(null);

  async function find() {
    setBusy(true);
    setError(null);
    setFound(null);
    try {
      const { normaliseHost } = await import('@/lib/school.ts');
      const host = normaliseHost(address);
      if (!host) {
        setError('That does not look like a web address. It is the address you '
          + 'use to open your school in a browser.');
        return;
      }

      const session = await import('@/lib/session.ts');
      const school = await session.resolveSchool(host);
      if (!school) {
        setError(`No school is registered at ${host}. Check the address with `
          + 'your school office.');
        return;
      }
      setFound({ name: school.name, logoUrl: school.logoUrl });
      await session.rememberSchool(school);
      router.replace('/sign-in');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach that address.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.page}>
      <Image
        source={require('../assets/logo.png')}
        style={styles.logo}
        resizeMode="contain"
        accessibilityRole="image"
        accessibilityLabel="paathshalaOS"
      />
      <Text style={styles.title}>Find your school</Text>
      <Text style={styles.lede}>
        Type the address you use to open your school in a browser — something
        like yourschool.paathshala.app.
      </Text>

      <TextInput
        style={styles.input}
        value={address}
        onChangeText={setAddress}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="yourschool.paathshala.app"
        onSubmitEditing={find}
        returnKeyType="go"
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}
      {found ? <Text style={styles.found}>Found {found.name}</Text> : null}

      <Pressable
        style={[styles.button, busy && styles.buttonBusy]}
        onPress={find}
        disabled={busy || address.trim().length === 0}
      >
        {busy
          ? <ActivityIndicator color="#fff" />
          : <Text style={styles.buttonText}>Continue</Text>}
      </Pressable>

      <Text style={styles.hint}>You only need to do this once on this phone.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, padding: 24, justifyContent: 'center' },
  logo: { width: '70%', height: 48, alignSelf: 'flex-start', marginBottom: 24 },
  title: { fontSize: 22, fontWeight: '700', color: theme.navy },
  lede: { marginTop: 8, marginBottom: 20, color: theme.slate, lineHeight: 20 },
  input: {
    borderWidth: 1, borderColor: theme.line, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 12, backgroundColor: '#fff',
    fontSize: 16,
  },
  error: { marginTop: 14, color: theme.critical, lineHeight: 19 },
  found: { marginTop: 14, color: theme.good, fontWeight: '600' },
  button: {
    marginTop: 22, backgroundColor: theme.teal, borderRadius: 10,
    paddingVertical: 14, alignItems: 'center',
  },
  buttonBusy: { opacity: 0.7 },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  hint: { marginTop: 14, fontSize: 12, color: theme.slate, textAlign: 'center' },
});
