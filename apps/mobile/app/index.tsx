import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, Pressable, StyleSheet, RefreshControl, ActivityIndicator,
} from 'react-native';
import { api, queue, signOut } from '@/lib/session.ts';
import {
  initialMarks, nextState, recordsFor, summarise, type Learner,
} from '@/lib/register.ts';
import { theme, stateColour } from '@/lib/theme.ts';
import type { AttendanceState } from '@paathshala/offline-queue';
import { router } from 'expo-router';

interface Section { id: string; name: string; academic_year_id: string }

const today = () => new Date().toISOString().slice(0, 10);

/**
 * The register.
 *
 * Deliberately the only screen in this app for now. It is the one thing a
 * teacher does every morning, it is the one thing that has to work with no
 * signal, and every other screen the web app has is better on a laptop.
 *
 * Almost nothing is decided here: which rows to send, what each tap does and
 * what the teacher is told all live in `src/lib/register.ts`, which is tested.
 */
export default function Register() {
  const [section, setSection] = useState<Section | null>(null);
  const [roll, setRoll] = useState<Learner[] | null>(null);
  const [marks, setMarks] = useState<Record<string, AttendanceState>>({});
  const [pending, setPending] = useState(0);
  const [note, setNote] = useState<{ message: string; tone: 'ok' | 'warn' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const sections = await api.get<Section[]>('/v1/sections');
      const first = sections[0] ?? null;
      setSection(first);
      if (!first) return;
      const learners = await api.get<Learner[]>(`/v1/students?sectionId=${first.id}`);
      setRoll(learners);
      setMarks(initialMarks(learners));
    } catch (e) {
      // An honest failure, not a stale roll. A register built from a class list
      // cached weeks ago silently omits every child who joined since.
      setLoadError(e instanceof Error ? e.message : 'Could not load the class list.');
    } finally {
      setPending(await queue.pendingCount());
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function submit() {
    if (!section || !roll) return;
    setBusy(true);
    try {
      const opened = await api.post<{ id: string }>('/v1/attendance/sessions', {
        sectionId: section.id,
        academicYearId: section.academic_year_id,
        sessionDate: today(),
        mode: 'day',
      });

      const records = recordsFor(roll, marks, () => globalThis.crypto.randomUUID());
      await queue.enqueue({
        localId: `${opened.id}:${today()}`,
        serverSessionId: opened.id,
        sectionId: section.id,
        sessionDate: today(),
        records,
      });

      const result = await queue.flush();
      const left = await queue.pendingCount();
      setPending(left);
      setNote(summarise(result, left, records.length));
    } catch (e) {
      setNote({
        message: e instanceof Error ? e.message : 'Could not save.',
        tone: 'warn',
      });
    } finally {
      setBusy(false);
    }
  }

  if (!roll && !loadError) {
    return <View style={styles.centre}><ActivityIndicator color={theme.teal} /></View>;
  }

  return (
    <View style={styles.page}>
      <View style={styles.head}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{section?.name ?? 'No class'}</Text>
          <Text style={styles.sub}>{today()}</Text>
        </View>
        {pending > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>
              {pending} waiting to send
            </Text>
          </View>
        ) : null}
      </View>

      {loadError ? <Text style={styles.error}>{loadError}</Text> : null}
      {note ? (
        <Text style={note.tone === 'warn' ? styles.warn : styles.ok}>{note.message}</Text>
      ) : null}

      <FlatList
        data={roll ?? []}
        keyExtractor={(l) => l.id}
        refreshControl={<RefreshControl refreshing={false} onRefresh={() => void load()} />}
        renderItem={({ item }) => {
          const state = marks[item.id] ?? 'present';
          return (
            <Pressable
              style={styles.row}
              onPress={() => setMarks((m) => ({ ...m, [item.id]: nextState(state) }))}
              accessibilityLabel={`${item.given_name}, ${state}`}
            >
              <Text style={styles.name}>
                {item.given_name}{item.family_name ? ` ${item.family_name}` : ''}
              </Text>
              <Text style={[styles.state, { color: stateColour[state] }]}>
                {state.replace('_', ' ')}
              </Text>
            </Pressable>
          );
        }}
      />

      <Pressable
        style={[styles.button, busy && styles.buttonBusy]}
        onPress={submit}
        disabled={busy || !roll?.length}
      >
        {busy
          ? <ActivityIndicator color="#fff" />
          : <Text style={styles.buttonText}>Save the register</Text>}
      </Pressable>

      <Pressable
        onPress={() => { void signOut().then(() => router.replace('/sign-in')); }}
      >
        <Text style={styles.signOut}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, padding: 16 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  head: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  title: { fontSize: 20, fontWeight: '700', color: theme.navy },
  sub: { color: theme.slate, marginTop: 2 },
  badge: {
    backgroundColor: '#FDE68A', paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 999,
  },
  badgeText: { color: '#713F12', fontSize: 12, fontWeight: '600' },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: theme.line,
  },
  name: { fontSize: 16, color: theme.navy, flex: 1 },
  state: { fontSize: 14, fontWeight: '700', textTransform: 'capitalize' },
  button: {
    marginTop: 12, backgroundColor: theme.teal, borderRadius: 10,
    paddingVertical: 16, alignItems: 'center',
  },
  buttonBusy: { opacity: 0.7 },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  ok: { color: theme.good, marginBottom: 10 },
  warn: { color: theme.warning, marginBottom: 10 },
  error: { color: theme.critical, marginBottom: 10 },
  signOut: {
    textAlign: 'center', color: theme.slate, paddingVertical: 14, fontSize: 13,
  },
});
