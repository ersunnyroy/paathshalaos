import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, FlatList, Pressable, StyleSheet, RefreshControl,
  ActivityIndicator, Linking,
} from 'react-native';
import { router } from 'expo-router';
import {
  initialStates, nextKind, eventsFor, summarise, tally, hhmm,
  KIND_LABEL, stableId, type ManifestRow,
} from '@/lib/bus.ts';
import { theme, boardingColour } from '@/lib/theme.ts';
import type { BoardingKind } from '@paathshala/offline-queue';

interface Route { id: string; code: string; name: string; child_count: number }

const today = () => new Date().toISOString().slice(0, 10);

/* Loaded here, not imported at the top: expo-router evaluates every file under
 * `app/` at startup, so a top-level import of anything native is an import
 * during module initialisation — before React exists, outside any boundary. */
const session = () => import('@/lib/session.ts');

/**
 * The bus run.
 *
 * Built for one hand at a kerb in the dark: whole rows are the tap target, the
 * state is the biggest thing on the row, and the guardian's number is one tap
 * from a call. Nothing here waits for the network — a tap is written to the
 * queue and the send happens when it happens.
 *
 * Almost nothing is decided in this file. What a tap means, what gets sent and
 * what the driver is told all live in `src/lib/bus.ts`, which is tested.
 */
export default function Bus() {
  const [routes, setRoutes] = useState<Route[] | null>(null);
  const [routeId, setRouteId] = useState('');
  const [direction, setDirection] = useState<'pickup' | 'drop'>(
    // Before midday it is the morning run. A driver should not have to tell
    // the app which way the bus is pointing.
    new Date().getHours() < 12 ? 'pickup' : 'drop');
  const [rows, setRows] = useState<ManifestRow[] | null>(null);
  const [states, setStates] = useState<Record<string, BoardingKind | null>>({});
  const [pending, setPending] = useState(0);
  const [note, setNote] = useState<{ message: string; tone: 'ok' | 'warn' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadRoutes = useCallback(async () => {
    try {
      const client = (await session()).api();
      const found = await client.get<Route[]>('/v1/transport/routes');
      setRoutes(found);
      setRouteId((current) => current || found[0]?.id || '');
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load your routes.');
    }
  }, []);

  const loadManifest = useCallback(async () => {
    if (!routeId) return;
    setLoadError(null);
    try {
      const client = (await session()).api();
      const manifest = await client.get<ManifestRow[]>(
        `/v1/transport/routes/${routeId}/manifest?direction=${direction}`);
      setRows(manifest);
      setStates(initialStates(manifest));
    } catch (e) {
      // An honest failure, not a stale list. A manifest cached from last week
      // silently omits every child added since, and on a bus that is a child
      // left at a kerb.
      setLoadError(e instanceof Error ? e.message : 'Could not load the list.');
      setRows([]);
    } finally {
      setPending(await (await (await session()).boardingQueue()).pendingCount());
    }
  }, [routeId, direction]);

  useEffect(() => { void loadRoutes(); }, [loadRoutes]);
  useEffect(() => { void loadManifest(); }, [loadManifest]);

  async function send() {
    if (!rows) return;
    setBusy(true);
    try {
      const q = await (await session()).boardingQueue();
      const events = eventsFor(rows, states, routeId, direction, today(),
        (key) => stableId(key));
      for (const event of events) await q.record(event);

      const result = await q.flush();
      const left = await q.pendingCount();
      setPending(left);
      setNote(summarise(result, left));
      // Only after a successful send: re-reading the manifest on a failure
      // would replace what the driver marked with what the server has, which
      // is the one thing the queue exists to prevent.
      if (result.failed === 0) await loadManifest();
    } catch (e) {
      setNote({
        message: e instanceof Error ? e.message : 'Could not save.',
        tone: 'warn',
      });
    } finally {
      setBusy(false);
    }
  }

  const counts = tally(rows ?? [], states);
  const route = routes?.find((r) => r.id === routeId);

  if (!rows && !loadError) {
    return <View style={styles.centre}><ActivityIndicator color={theme.teal} /></View>;
  }

  return (
    <View style={styles.page}>
      <View style={styles.head}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{route ? `${route.code} · ${route.name}` : 'No route'}</Text>
          <Text style={styles.sub}>
            {counts.onBoard} on board
            {counts.missing > 0 ? ` · ${counts.missing} not at stop` : ''}
            {counts.unmarked > 0 ? ` · ${counts.unmarked} to go` : ''}
          </Text>
        </View>
        {pending > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{pending} waiting</Text>
          </View>
        ) : null}
      </View>

      <View style={styles.switcher}>
        {(['pickup', 'drop'] as const).map((d) => (
          <Pressable key={d} onPress={() => setDirection(d)}
                     style={[styles.tab, direction === d && styles.tabOn]}>
            <Text style={[styles.tabText, direction === d && styles.tabTextOn]}>
              {d === 'pickup' ? 'Morning' : 'Afternoon'}
            </Text>
          </Pressable>
        ))}
      </View>

      {(routes?.length ?? 0) > 1 ? (
        <View style={styles.switcher}>
          {routes!.map((r) => (
            <Pressable key={r.id} onPress={() => setRouteId(r.id)}
                       style={[styles.tab, r.id === routeId && styles.tabOn]}>
              <Text style={[styles.tabText, r.id === routeId && styles.tabTextOn]}>
                {r.code}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {loadError ? <Text style={styles.error}>{loadError}</Text> : null}
      {note ? (
        <Text style={note.tone === 'warn' ? styles.warn : styles.ok}>{note.message}</Text>
      ) : null}

      <FlatList
        data={rows ?? []}
        keyExtractor={(r) => r.student_id}
        refreshControl={
          <RefreshControl refreshing={false} onRefresh={() => void loadManifest()} />}
        ListEmptyComponent={
          loadError ? null : (
            <Text style={styles.empty}>
              Nobody is on this route in this direction today.
            </Text>
          )}
        renderItem={({ item }) => {
          const state = states[item.student_id] ?? null;
          return (
            <Pressable
              style={styles.row}
              onPress={() => setStates((s) => ({
                ...s, [item.student_id]: nextKind(state),
              }))}
              accessibilityLabel={
                `${item.given_name}, ${item.stop_name}, `
                + `${state ? KIND_LABEL[state] : 'not marked'}`}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.name}>
                  {item.given_name}{item.family_name ? ` ${item.family_name}` : ''}
                </Text>
                <Text style={styles.stop}>
                  {item.sequence_no}. {item.stop_name}
                  {hhmm(direction === 'pickup' ? item.pickup_time : item.drop_time)
                    ? ` · ${hhmm(direction === 'pickup' ? item.pickup_time : item.drop_time)}`
                    : ''}
                </Text>
              </View>

              {/* One tap from a call. When a child is not at their stop the
                  driver needs somebody in the next thirty seconds, and
                  "ring the school office" is not an answer at 7am. */}
              {item.guardian_phone ? (
                <Pressable
                  hitSlop={10}
                  onPress={() => void Linking.openURL(`tel:${item.guardian_phone}`)}
                  accessibilityLabel={`Call ${item.given_name}'s guardian`}
                >
                  <Text style={styles.call}>Call</Text>
                </Pressable>
              ) : null}

              <Text style={[styles.state, { color: boardingColour(state) }]}>
                {state ? KIND_LABEL[state] : '—'}
              </Text>
            </Pressable>
          );
        }}
      />

      <Pressable style={[styles.button, busy && styles.buttonBusy]}
                 onPress={send} disabled={busy || !rows?.length}>
        {busy
          ? <ActivityIndicator color="#fff" />
          : <Text style={styles.buttonText}>Send the run</Text>}
      </Pressable>

      <Pressable onPress={() => {
        void (async () => {
          await (await session()).signOut();
          router.replace('/sign-in');
        })();
      }}>
        <Text style={styles.signOut}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, padding: 16 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  head: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  title: { fontSize: 19, fontWeight: '700', color: theme.navy },
  sub: { color: theme.slate, marginTop: 2, fontSize: 13 },
  badge: {
    backgroundColor: '#FDE68A', paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 999,
  },
  badgeText: { color: '#713F12', fontSize: 12, fontWeight: '600' },
  switcher: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  tab: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
    borderWidth: 1, borderColor: theme.line,
  },
  tabOn: { backgroundColor: theme.navy, borderColor: theme.navy },
  tabText: { color: theme.slate, fontWeight: '600', fontSize: 13 },
  tabTextOn: { color: '#fff' },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    // Tall rows on purpose: this is tapped one-handed, at a kerb, in the dark.
    paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: theme.line,
  },
  name: { fontSize: 17, color: theme.navy, fontWeight: '600' },
  stop: { fontSize: 13, color: theme.slate, marginTop: 2 },
  call: { color: theme.teal, fontWeight: '700', fontSize: 14 },
  state: { fontSize: 14, fontWeight: '700', minWidth: 84, textAlign: 'right' },
  empty: { color: theme.slate, textAlign: 'center', paddingVertical: 30 },
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
