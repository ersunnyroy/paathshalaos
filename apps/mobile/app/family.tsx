import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, Pressable, StyleSheet, RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { router } from 'expo-router';
import {
  tabsFor, rupees, attendanceRate, feeState, childName, childClass, ATTENDANCE_STATES,
  type Child, type Tab, type Fees, type AttendanceSummary,
} from '@/lib/family.ts';
import { english, type StringKey, type Translator } from '@/lib/i18n.ts';
import { sortWork, outstanding, workLine, bucketOf, type Work } from '@/lib/learning.ts';
import { asOfLabel } from '@/lib/cache.ts';
import { theme } from '@/lib/theme.ts';

/* Loaded here, not imported at the top: expo-router evaluates every file under
 * `app/` at startup, so a top-level import of anything native runs before
 * React exists, outside any error boundary. */
const session = () => import('@/lib/session.ts');

interface ResultRun {
  result_run_id: string; term_label: string | null; published_at: string | null;
  lines: Array<{
    subject: string | null; percentage: string | null; grade_label: string | null;
    is_pass: boolean | null; not_graded_reason: string | null;
  }>;
}
interface Bus {
  route_code: string; route_name: string; stop_name: string;
  pickup_time: string | null; drop_time: string | null;
  vehicle_registration: string | null; direction: string;
}

/**
 * Attendance states come off the wire, so the key is built rather than looked
 * up — and a state this app has no word for falls through to the raw value
 * instead of a blank cell. A register that says `half_day` is worse than one
 * that says nothing only if you never have to explain the blank.
 */
const ATTENDANCE_KEYS = new Set<string>(ATTENDANCE_STATES);

/**
 * The parent app.
 *
 * One screen, a child at the top and a tab underneath, because a parent opens
 * this to answer one question and then closes it. A navigation tree would be
 * three taps to a number they wanted in one.
 *
 * Every panel says when it was last told. A cached answer is never drawn as a
 * live one — see `cache.ts`, where that rule is enforced and tested. A parent
 * looking at "you owe ₹10,000" the day after they paid has been told something
 * false, and the stamp is the whole defence.
 */
export default function Family() {
  const [children, setChildren] = useState<Child[] | null>(null);
  const [childId, setChildId] = useState('');
  const [tab, setTab] = useState<Tab>('attendance');
  const [panel, setPanel] = useState<{
    data: unknown; asOf: string; live: boolean;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /*
   * Starts in English and is corrected, rather than waiting for the chain
   * before drawing anything. The first frame after launch uses what the phone
   * remembered; the server's answer arrives a moment later. A blank screen on
   * a train, in aid of a language the phone already knew, is the alternative.
   */
  const [say, setSay] = useState<Translator>(() => english);

  const child = children?.find((c) => c.id === childId) ?? null;
  const tabs = child ? tabsFor(child) : [];

  useEffect(() => {
    void (async () => {
      const s = await session();
      const remembered = await s.loadLocale();
      setSay(() => remembered);
      const fresh = await s.refreshLocale();
      setSay(() => fresh);
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const s = await session();
        const held = await (await s.cache()).read('children',
          () => s.api().get<Child[]>('/v1/family/children'));
        if (!held) { setChildren([]); return; }
        setChildren(held.data);
        setChildId((current) => current || held.data[0]?.id || '');
      } catch (e) {
        setError(e instanceof Error ? e.message : say('error.children'));
        setChildren([]);
      }
    })();
  }, []);

  // A tab the current child does not have — the other child's fees, say — is
  // not a blank panel. It is the first tab they do have.
  useEffect(() => {
    if (tabs.length > 0 && !tabs.includes(tab)) setTab(tabs[0]!);
  }, [tabs, tab]);

  const load = useCallback(async () => {
    if (!childId || !tabs.includes(tab)) return;
    setLoading(true);
    setError(null);
    setPanel(null);
    try {
      const s = await session();
      // Homework is the one panel that is not served by the family module.
      // It is the learning module's own endpoint, behind the `lms` flag, and
      // giving it a second route under /v1/family would have meant two places
      // deciding who may see a child's marks.
      const url = tab === 'work'
        ? `/v1/learning/students/${childId}/work?includeReturned=true`
        : `/v1/family/${
            tab === 'attendance' ? `children/${childId}/attendance`
            : tab === 'fees' ? `children/${childId}/fees`
            : tab === 'results' ? `children/${childId}/results`
            : `children/${childId}/transport`}`;
      const held = await (await s.cache()).read(`${tab}:${childId}`,
        () => s.api().get<unknown>(url));
      if (!held) {
        setError(say('error.offline'));
      } else {
        setPanel(held);
      }
    } catch (e) {
      // A refusal reaches here rather than being papered over with the cache.
      setError(e instanceof Error ? e.message : say('error.panel'));
    } finally {
      setLoading(false);
    }
  }, [childId, tab, tabs]);

  useEffect(() => { void load(); }, [load]);

  if (children === null) {
    return <View style={styles.centre}><ActivityIndicator color={theme.teal} /></View>;
  }

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={{ padding: 16 }}
      refreshControl={<RefreshControl refreshing={false} onRefresh={() => void load()} />}
    >
      {children.length === 0 ? (
        <Text style={styles.empty}>{say('family.noChildren')}</Text>
      ) : null}

      {children.length > 1 ? (
        <View style={styles.switcher}>
          {children.map((c) => (
            <Pressable key={c.id} onPress={() => setChildId(c.id)}
                       style={[styles.chip, c.id === childId && styles.chipOn]}>
              <Text style={[styles.chipText, c.id === childId && styles.chipTextOn]}>
                {c.given_name}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {child ? (
        <>
          <Text style={styles.title}>{childName(child)}</Text>
          <Text style={styles.sub}>
            {childClass(child) ?? say('child.noClass')} · {child.admission_no}
          </Text>

          <View style={styles.switcher}>
            {tabs.map((t) => (
              <Pressable key={t} onPress={() => setTab(t)}
                         style={[styles.chip, t === tab && styles.chipOn]}>
                <Text style={[styles.chipText, t === tab && styles.chipTextOn]}>
                  {say(`tab.${t}` as StringKey)}
                </Text>
              </Pressable>
            ))}
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}
          {loading ? <ActivityIndicator color={theme.teal} style={{ marginTop: 20 }} /> : null}

          {panel ? (
            <>
              {/* Not a footnote. A parent reading a balance has to know
                  whether it is this morning's or Tuesday's. */}
              {!panel.live ? (
                <View style={styles.stale}>
                  <Text style={styles.staleText}>
                    {say('cache.stale', { when: asOfLabel(panel.asOf) })}
                  </Text>
                </View>
              ) : null}

              {tab === 'attendance'
                ? <Attendance summary={panel.data as AttendanceSummary} say={say} />
                : tab === 'fees' ? <FeesPanel fees={panel.data as Fees} say={say} />
                : tab === 'work' ? <WorkPanel rows={panel.data as Work[]} say={say} />
                : tab === 'results' ? <Results runs={panel.data as ResultRun[]} say={say} />
                : <BusPanel bus={panel.data as Bus | null} say={say} />}
            </>
          ) : null}
        </>
      ) : null}

      <Pressable onPress={() => {
        void (async () => {
          await (await session()).signOut();
          router.replace('/sign-in');
        })();
      }}>
        <Text style={styles.signOut}>{say('action.signOut')}</Text>
      </Pressable>
    </ScrollView>
  );
}

function Attendance({ summary, say }: { summary: AttendanceSummary; say: Translator }) {
  const rate = attendanceRate(summary);
  return (
    <View>
      <Text style={styles.big}>
        {rate === null ? say('attendance.none') : `${rate}%`}
      </Text>
      <Text style={styles.sub}>
        {summary.recorded === 0
          ? say('attendance.noRegister')
          : say('attendance.daysInSchool', {
              inSchool: summary.present + summary.late, recorded: summary.recorded })}
      </Text>
      {summary.days.map((d) => (
        <View key={d.on_date} style={styles.row}>
          <Text style={styles.rowKey}>{d.on_date}</Text>
          <Text style={[styles.rowValue,
            d.state === 'absent' ? { color: theme.critical } : null]}>
            {ATTENDANCE_KEYS.has(d.state)
              ? say(`attendance.${d.state}` as StringKey) : d.state}
          </Text>
        </View>
      ))}
    </View>
  );
}

function FeesPanel({ fees, say }: { fees: Fees; say: Translator }) {
  const state = feeState(fees);
  return (
    <View>
      <Text style={styles.big}>{rupees(fees.outstanding_paise)}</Text>
      <Text style={styles.sub}>
        {state.kind === 'clear' ? say('fees.clear')
          : state.kind === 'overdue' ? say('fees.overdue', { days: state.days })
            : state.days === 0 ? say('fees.dueToday')
              : say('fees.dueIn', { days: state.days })}
      </Text>
      {fees.invoices.map((i) => (
        <View key={i.id} style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowKey}>{i.invoice_no}</Text>
            <Text style={styles.tiny}>{say('fees.invoiceDue', { date: i.due_on })}</Text>
          </View>
          <Text style={styles.rowValue}>{rupees(i.outstanding_paise)}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * What is set, and what has come back.
 *
 * The count at the top is the answer to the question the parent opened the app
 * with, so it is the first thing on the screen and it is a count of what is
 * WAITING — not of what exists. A list headed "8 pieces of homework" when six
 * are finished is a number that makes somebody scroll to find out it was
 * nothing.
 */
function WorkPanel({ rows, say }: { rows: Work[]; say: Translator }) {
  if (rows.length === 0) {
    return (
      <Text style={styles.empty}>{say('work.none')}</Text>
    );
  }
  const waiting = outstanding(rows);
  return (
    <View>
      <Text style={styles.big}>{waiting}</Text>
      <Text style={styles.sub}>
        {waiting === 0 ? say('work.clear') : say('work.waiting', { count: waiting })}
      </Text>
      {sortWork(rows).map((w) => {
        const bucket = bucketOf(w);
        return (
          <View key={w.assignment_id} style={styles.row}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={styles.rowKey}>{w.title}</Text>
              <Text style={styles.sub}>{w.subject_name}</Text>
              {w.feedback ? <Text style={styles.sub}>“{w.feedback}”</Text> : null}
            </View>
            <Text style={[styles.rowValue, bucket === 'overdue' && styles.overdue]}>
              {workLine(w)}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function Results({ runs, say }: { runs: ResultRun[]; say: Translator }) {
  if (runs.length === 0) {
    return (
      <Text style={styles.empty}>{say('results.none')}</Text>
    );
  }
  return (
    <View>
      {runs.map((run) => (
        <View key={run.result_run_id} style={{ marginBottom: 18 }}>
          <Text style={styles.heading}>{run.term_label ?? say('results.heading')}</Text>
          {run.lines.map((line, i) => (
            <View key={`${run.result_run_id}-${i}`} style={styles.row}>
              <Text style={styles.rowKey}>{line.subject ?? say('results.overall')}</Text>
              <Text style={styles.rowValue}>
                {line.not_graded_reason
                  ? line.not_graded_reason
                  : line.grade_label ?? (line.percentage
                    ? `${Number(line.percentage).toFixed(1)}%` : say('results.notGraded'))}
              </Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

function BusPanel({ bus, say }: { bus: Bus | null; say: Translator }) {
  if (!bus) {
    return <Text style={styles.empty}>{say('bus.none')}</Text>;
  }
  return (
    <View>
      <Text style={styles.big}>{bus.route_code}</Text>
      <Text style={styles.sub}>{bus.route_name}</Text>
      <View style={styles.row}>
        <Text style={styles.rowKey}>{say('bus.stop')}</Text>
        <Text style={styles.rowValue}>{bus.stop_name}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.rowKey}>{say('bus.pickup')}</Text>
        <Text style={styles.rowValue}>{bus.pickup_time?.slice(0, 5) ?? '—'}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.rowKey}>{say('bus.drop')}</Text>
        <Text style={styles.rowValue}>{bus.drop_time?.slice(0, 5) ?? '—'}</Text>
      </View>
      {bus.vehicle_registration ? (
        <View style={styles.row}>
          <Text style={styles.rowKey}>{say('bus.vehicle')}</Text>
          <Text style={styles.rowValue}>{bus.vehicle_registration}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 22, fontWeight: '700', color: theme.navy },
  sub: { color: theme.slate, marginTop: 3, fontSize: 13 },
  heading: { fontSize: 15, fontWeight: '700', color: theme.navy, marginBottom: 6 },
  big: { fontSize: 32, fontWeight: '700', color: theme.navy, marginTop: 6 },
  switcher: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginVertical: 12 },
  chip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
    borderWidth: 1, borderColor: theme.line,
  },
  chipOn: { backgroundColor: theme.navy, borderColor: theme.navy },
  chipText: { color: theme.slate, fontWeight: '600', fontSize: 13 },
  chipTextOn: { color: '#fff' },
  stale: {
    backgroundColor: '#FEF3C7', borderRadius: 8, padding: 12, marginTop: 12,
  },
  staleText: { color: '#713F12', fontSize: 13 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: theme.line,
  },
  rowKey: { flex: 1, color: theme.navy, fontSize: 15 },
  rowValue: { color: theme.slate, fontSize: 15, fontWeight: '600' },
  overdue: { color: theme.critical, fontWeight: '600' },
  tiny: { color: theme.slate, fontSize: 12, marginTop: 2 },
  empty: { color: theme.slate, paddingVertical: 24, fontSize: 14 },
  error: { color: theme.critical, marginTop: 12 },
  signOut: {
    textAlign: 'center', color: theme.slate, paddingVertical: 22, fontSize: 13,
  },
});
