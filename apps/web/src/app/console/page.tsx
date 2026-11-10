'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import {
  consoleGet, consolePost, consoleLogin, consoleToken, clearConsole,
  assumeSchoolSession, ApiError,
} from '@/lib/api';
import { Lockup, Panel, Pill, Empty, Icon, SkeletonRows } from '@/components/ui';
import { Plans, Billing, Team, ConfirmButton, NewSchool } from './panels';
import { estate } from '@/lib/console';

/**
 * The platform console.
 *
 * Web only, on purpose — there is no version of this in the mobile app and there
 * should not be. A phone is where somebody taps the wrong row on a train, and
 * the wrong row here means standing in a real school's shoes.
 *
 * The shape of this screen is the argument of M15 in one page: a search that
 * cannot look inside a school, a health table that counts our relationship with
 * each school rather than their business, and an entry control that asks for a
 * sentence before it opens anything. What it deliberately does not have is a
 * grid of every learner in the estate.
 */

interface SchoolHit { id: string; display_name: string; status: string; created_at: string }
interface AccountHit {
  user_account_id: string; login_email: string; status: string;
  tenant_id: string; display_name: string; roles: string[];
}
interface Health extends SchoolHit {
  accounts: number; owners: number; live_sessions: number;
  last_entered_at: string | null; provisioned_at: string | null;
}
interface Person {
  user_account_id: string; login_email: string; status: string; roles: string[];
}
interface SessionRow {
  id: string; tenant_id: string; display_name: string | null; actor_email: string | null;
  assumed_role: string | null; write_enabled: boolean; entry_path: string;
  status: string; reason: string; started_at: string | null; expires_at: string | null;
}
interface Entry { id: string; accessToken: string; expiresAt: string; writeEnabled: boolean }

const when = (value: string | null) =>
  value ? new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

export default function ConsolePage() {
  const [ready, setReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    setSignedIn(consoleToken() !== null);
    setReady(true);
  }, []);

  if (!ready) return null;
  return signedIn
    ? <Console onSignOut={() => { clearConsole(); setSignedIn(false); }} />
    : <ConsoleLogin onIn={() => setSignedIn(true)} />;
}

/* ------------------------------------------------------------------- login */

function ConsoleLogin({ onIn }: { onIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await consoleLogin(email, password);
      onIn();
    } catch (e) {
      // The API says the same thing for a wrong password and for an account
      // that is simply not platform staff, and so does this. Anything more
      // helpful here is a list of who can open the console.
      setError(e instanceof ApiError ? e.message : 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth" style={{ gridTemplateColumns: '360px' }}>
      <div className="auth-card">
        <div style={{ marginBottom: 18 }}>
          <Lockup height={30} />
          <div className="sub" style={{ marginTop: 8 }}>Platform console</div>
        </div>
        <form onSubmit={submit}>
          <label htmlFor="console-email">Email</label>
          <input id="console-email" type="email" value={email} autoComplete="username"
                 onChange={(e) => setEmail(e.target.value)} required />
          <label htmlFor="console-password">Password</label>
          <input id="console-password" type="password" value={password}
                 autoComplete="current-password"
                 onChange={(e) => setPassword(e.target.value)} required />
          {error ? <div className="note bad" style={{ marginTop: 14 }}>{error}</div> : null}
          <div className="note" style={{ marginTop: 14 }}>
            <span>
              Entering a school from here is recorded, carries your name, and the
              school can see it and end it.
            </span>
          </div>
          <button className="primary" type="submit" disabled={busy}
                  style={{ width: '100%', marginTop: 16, justifyContent: 'center' }}>
            {busy ? 'Checking…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- console */

interface Task {
  key: string; description: string; enabled: boolean; interval_seconds: number;
  next_run_at: string; running_since: string | null;
  last_finished_at: string | null; last_status: string | null; last_error: string | null;
  consecutive_failures: number;
  seconds_since_success: string | null;
  overdue: boolean;
  failures_this_week: number;
  implemented: boolean;
}

/**
 * What ran, and — the part that matters — what has stopped running (M33.3).
 *
 * The column to read is the last one. A task that FAILS is loud: a failed run,
 * a log line, a metric. A task that has stopped being claimed at all produces
 * nothing whatsoever, and the only evidence is an age that keeps growing. Every
 * scheduled job in this product was in that state until M33, including the one
 * that makes the audit log tamper-evident and the one that deletes children's
 * documents a year after a school said no.
 */
function Schedule() {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    consoleGet<Task[]>('/schedule').then(setTasks).catch(() => setTasks([]));
  }, []);
  useEffect(load, [load]);

  const age = (seconds: string | null) => {
    // Never run is not "0 seconds ago". The two must not look the same, which
    // is the same rule the metric follows and for the same reason.
    if (seconds === null) return 'never';
    const n = Number(seconds);
    if (n < 3600) return `${Math.floor(n / 60)}m ago`;
    if (n < 172_800) return `${Math.floor(n / 3600)}h ago`;
    return `${Math.floor(n / 86_400)}d ago`;
  };

  async function runNow(key: string) {
    setBusy(true); setSaid(null);
    try {
      await consolePost(`/schedule/${key}/run-now`, {});
      // Queued, not run. The scheduler picks it up within fifteen seconds; an
      // endpoint that ran a fleet-wide purge on this request would put it on an
      // HTTP timeout.
      setSaid(`${key} is queued — the scheduler will take it within a minute.`);
      load();
    } catch (e) {
      setSaid((e as ApiError).message);
    } finally { setBusy(false); }
  }

  return (
    <Panel title="Scheduled work"
           hint="A job that fails is loud. A job that stops being claimed is silent — read the last column.">
      {said ? <div className="note">{said}</div> : null}
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Task</th><th>Every</th><th>Last</th><th>Failures (7d)</th>
              <th>Last success</th><th />
            </tr>
          </thead>
          {tasks === null ? <SkeletonRows cols={6} /> : (
            <tbody>
              {tasks.map((t) => (
                <tr key={t.key}>
                  <td>
                    <strong>{t.key}</strong>
                    {!t.implemented
                      ? <> <Pill tone="critical">no code</Pill></> : null}
                    {t.overdue ? <> <Pill tone="critical">overdue</Pill></> : null}
                    {t.running_since ? <> <Pill tone="warning">running</Pill></> : null}
                    {!t.enabled ? <> <Pill>off</Pill></> : null}
                    <span className="reason" title={t.description}>{t.description}</span>
                  </td>
                  <td>{Math.round(t.interval_seconds / 3600)}h</td>
                  <td>
                    {t.last_status
                      ? <Pill tone={t.last_status === 'ok' ? undefined : 'critical'}>
                          {t.last_status}
                        </Pill>
                      : <span className="sub">—</span>}
                    {t.last_error
                      ? <span className="reason" title={t.last_error}>{t.last_error}</span>
                      : null}
                  </td>
                  <td>{t.failures_this_week}</td>
                  <td>{age(t.seconds_since_success)}</td>
                  <td>
                    <button className="ghost" disabled={busy || !t.enabled}
                            onClick={() => void runNow(t.key)}>
                      Run now
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          )}
        </table>
      </div>
    </Panel>
  );
}

type Tab = 'schools' | 'plans' | 'billing' | 'team' | 'operations';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'schools', label: 'Schools' },
  { id: 'plans', label: 'Plans' },
  { id: 'billing', label: 'Billing' },
  { id: 'team', label: 'Team' },
  { id: 'operations', label: 'Operations' },
];

function Console({ onSignOut }: { onSignOut: () => void }) {
  const [health, setHealth] = useState<Health[] | null>(null);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<{ schools: SchoolHit[]; accounts: AccountHit[] } | null>(null);
  const [target, setTarget] = useState<{ tenantId: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('schools');
  const [said, setSaid] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function setStatus(school: Health, action: 'suspend' | 'resume') {
    setError(null); setSaid(null);
    try {
      await consolePost(`/tenants/${school.id}/${action}`, {});
      setSaid(action === 'suspend'
        ? `${school.display_name} is suspended. Nobody there can sign in until it is resumed.`
        : `${school.display_name} is active again.`);
      refresh();
    } catch (e) {
      setError((e as ApiError).message);
    }
  }

  const refresh = useCallback(() => {
    consoleGet<Health[]>('/health').then(setHealth).catch((e: ApiError) => setError(e.message));
    consoleGet<SessionRow[]>('/sessions').then(setSessions).catch(() => setSessions([]));
  }, []);

  useEffect(refresh, [refresh]);

  async function search(event: FormEvent) {
    event.preventDefault();
    setHits(await consoleGet('/search?q=' + encodeURIComponent(query)));
  }

  const live = (health ?? []).reduce((n, s) => n + s.live_sessions, 0);

  return (
    <div className="console">
      <header className="console-bar">
        <Lockup height={22} />
        <span className="tag">Console</span>
        <span className="spacer" />
        {live > 0 ? <Pill tone="warning">{live} inside a school now</Pill> : null}
        <button className="ghost" onClick={onSignOut}><Icon.out /><span>Sign out</span></button>
      </header>

      <main className="console-body">
        <div className="console-tabs" role="tablist" aria-label="Console sections">
          {TABS.map((t) => (
            <button key={t.id} role="tab" type="button" aria-selected={tab === t.id}
                    onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </div>

        {error ? <div className="note bad">{error}</div> : null}
        {said ? <div className="note">{said}</div> : null}

        {tab === 'plans' ? <Plans /> : null}
        {tab === 'billing' ? <Billing schools={health ?? []} /> : null}
        {tab === 'team' ? <Team /> : null}
        {tab === 'operations' ? <Schedule /> : null}

        {tab === 'schools' ? (<>
        {health ? (() => {
          const e = estate(health);
          return (
            <div className="figures boxed">
              <div><span>Schools</span><strong>{e.total}</strong></div>
              <div><span>Active</span><strong>{e.active}</strong></div>
              <div><span>Suspended</span><strong>{e.suspended}</strong></div>
              <div><span>With no owner</span><strong>{e.ownerless}</strong></div>
              <div><span>Accounts</span><strong>{e.accounts}</strong></div>
            </div>
          );
        })() : null}

        <form className="console-search" onSubmit={search}>
          <input value={query} onChange={(e) => setQuery(e.target.value)}
                 placeholder="A school's name, or the email address somebody wrote from" />
          <button className="primary" type="submit">Search</button>
        </form>

        {hits ? (
          <Panel title="Results"
                 hint="Schools and accounts. Not learners — those live inside a school, where this console cannot reach.">
            {hits.schools.length === 0 && hits.accounts.length === 0
              ? <Empty title="Nothing matched" />
              : (
                <div className="body">
                  {hits.schools.map((s) => (
                    <div className="hit" key={s.id}>
                      <div>
                        <strong>{s.display_name}</strong>
                        <span className="sub">School · {s.status}</span>
                      </div>
                      <button onClick={() => setTarget({ tenantId: s.id, name: s.display_name })}>
                        Enter…
                      </button>
                    </div>
                  ))}
                  {hits.accounts.map((a) => (
                    <div className="hit" key={`${a.user_account_id}-${a.tenant_id}`}>
                      <div>
                        <strong>{a.login_email}</strong>
                        <span className="sub">
                          {a.display_name} · {a.roles.join(', ')}
                        </span>
                      </div>
                      <button onClick={() => setTarget({ tenantId: a.tenant_id, name: a.display_name })}>
                        Enter…
                      </button>
                    </div>
                  ))}
                </div>
              )}
          </Panel>
        ) : null}

        <Panel title="Schools"
               hint="Our relationship with each school. Deliberately not a count of their learners or their money."
               actions={<button className="primary" onClick={() => setCreating(true)}>New school</button>}>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>School</th><th>Status</th><th className="num">Accounts</th>
                  <th className="num">Owners</th><th>Last entered</th><th />
                </tr>
              </thead>
              {health === null ? <SkeletonRows cols={6} /> : (
                <tbody>
                  {health.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <strong>{s.display_name}</strong>
                        {s.live_sessions > 0
                          ? <> <Pill tone="warning">inside now</Pill></> : null}
                      </td>
                      <td>
                        <Pill tone={s.status === 'active' ? 'good'
                          : s.status === 'suspended' ? 'critical' : undefined}>
                          {s.status}
                        </Pill>
                      </td>
                      <td className="num">{s.accounts}</td>
                      <td className="num">
                        {s.owners === 0 ? <Pill tone="critical">none</Pill> : s.owners}
                      </td>
                      <td>{when(s.last_entered_at)}</td>
                      <td className="num">
                        <span className="row" style={{ justifyContent: 'flex-end' }}>
                          {s.status === 'suspended'
                            ? <ConfirmButton label="Resume" confirmLabel="Resume school"
                                             onConfirm={() => setStatus(s, 'resume')} />
                            : <ConfirmButton label="Suspend" confirmLabel="Suspend — locks everyone out"
                                             tone="critical" onConfirm={() => setStatus(s, 'suspend')} />}
                          <button onClick={() => setTarget({ tenantId: s.id, name: s.display_name })}>
                            Enter…
                          </button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              )}
            </table>
          </div>
        </Panel>

        </>) : null}

        {tab === 'operations' ? (
        <Panel title="Access log"
               hint="Every entry, ours and theirs. The school sees this same list for itself.">
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Who</th><th>School</th><th>As</th><th>Why</th>
                  <th>Started</th><th>State</th>
                </tr>
              </thead>
              {sessions === null ? <SkeletonRows cols={6} /> : sessions.length === 0 ? (
                <tbody>
                  <tr><td colSpan={6}><Empty title="Nobody has entered a school yet" /></td></tr>
                </tbody>
              ) : (
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id}>
                      <td>{s.actor_email ?? '—'}</td>
                      <td>{s.display_name ?? '—'}</td>
                      <td>
                        {s.assumed_role ?? 'them'}
                        {s.write_enabled ? <> <Pill tone="critical">write</Pill></> : null}
                      </td>
                      <td className="reason" title={s.reason}>{s.reason}</td>
                      <td>{when(s.started_at)}</td>
                      <td>
                        <Pill tone={s.status === 'active' ? 'warning' : undefined}>{s.status}</Pill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              )}
            </table>
          </div>
        </Panel>
        ) : null}
      </main>

      {creating ? <NewSchool onClose={() => setCreating(false)} onCreated={refresh} /> : null}

      {target ? (
        <EnterDialog school={target} onClose={() => setTarget(null)} onEntered={refresh} />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------- entry */

/**
 * Pick a person, say why, go.
 *
 * There is no "enter as a teacher" option without a name attached, because the
 * database cannot express one: every policy decides by actor, so there is no
 * generic teacher's view — only a particular teacher's. Making the console pick
 * somebody silently would put a name in the school's access log that the person
 * entering never saw.
 */
function EnterDialog({ school, onClose, onEntered }: {
  school: { tenantId: string; name: string };
  onClose: () => void;
  onEntered: () => void;
}) {
  const router = useRouter();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [chosen, setChosen] = useState<Person | null>(null);
  const [role, setRole] = useState('');
  const [reason, setReason] = useState('');
  const [write, setWrite] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    consoleGet<Person[]>(`/tenants/${school.tenantId}/people`)
      .then(setPeople)
      .catch((e: ApiError) => { setError(e.message); setPeople([]); });
  }, [school.tenantId]);

  async function enter() {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const session = await consolePost<Entry>('/enter', {
        tenantId: school.tenantId,
        targetUserId: chosen.user_account_id,
        ...(role ? { assumedRole: role } : {}),
        ...(write ? { write: true } : {}),
        reason,
      });
      assumeSchoolSession(session.accessToken);
      onEntered();
      router.push('/dashboard');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not enter.');
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>Enter {school.name}</h2>
        <p className="lede">
          You will see exactly what this person sees — no more. The school is told
          you were here and can end the session.
        </p>

        <label>As
          <select value={chosen?.user_account_id ?? ''}
                  onChange={(e) => {
                    const person = (people ?? [])
                      .find((p) => p.user_account_id === e.target.value) ?? null;
                    setChosen(person);
                    setRole('');
                  }}>
            <option value="">{people === null ? 'Loading…' : 'Choose a person'}</option>
            {(people ?? []).map((p) => (
              <option key={p.user_account_id} value={p.user_account_id}>
                {p.login_email} — {p.roles.join(', ')}
              </option>
            ))}
          </select>
        </label>

        {chosen && chosen.roles.length > 1 ? (
          <label>Exercising
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="">All of their roles</option>
              {chosen.roles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
        ) : null}

        <label>Why
          <textarea value={reason} rows={2} onChange={(e) => setReason(e.target.value)}
                    placeholder="A sentence the school would find satisfying when they read it." />
        </label>

        <label className="check">
          <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} />
          <span>
            Let me change their records
            <em>Needs the write capability. Almost nothing does.</em>
          </span>
        </label>

        {error ? <div className="note bad">{error}</div> : null}

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button className="primary" onClick={enter}
                  disabled={busy || !chosen || reason.trim().length < 10}>
            {busy ? 'Entering…' : 'Enter'}
          </button>
        </div>
      </div>
    </div>
  );
}
