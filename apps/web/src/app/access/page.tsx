'use client';

/**
 * Access (M32.6).
 *
 * Until now every account in this system was made by the seed or by a test. A
 * school that hired a teacher in October could not give them a login, which
 * makes every other permission in the product decorative.
 *
 * The role picker is filled from `/v1/access/delegatable`, which asks the
 * service's own `canDelegate` rule — not from a list written here. A screen
 * that offers a role the API will refuse teaches people that the product is
 * broken; a screen with its own copy of the rule is a copy that drifts.
 */
import { useCallback, useEffect, useState } from 'react';
import { Shell, PageHead } from '../shell';
import { Empty, Panel, Pill, SkeletonRows, Tile } from '@/components/ui';
import { apiGet, apiPost } from '@/lib/api';

interface Grant {
  id: string; role: string; scope_type: string; scope_id: string | null;
  granted_at: string; expires_at: string | null;
}
interface Account {
  user_account_id: string; person_id: string | null;
  given_name: string | null; family_name: string | null;
  employee_code: string | null; designation: string | null;
  left_on: string | null;
  grants: Grant[];
}
interface Campus { id: string; name: string }
interface Section { id: string; section_name: string; class_name: string | null }

const SCOPE_LABEL: Record<string, string> = {
  organization: 'the whole school',
  campus: 'one campus',
  academic_unit: 'one academic unit',
  class_group: 'one class',
  section: 'one section',
  self: 'themselves only',
};

const who = (a: Account) =>
  [a.given_name, a.family_name].filter(Boolean).join(' ') || 'Unnamed account';

export default function AccessPage() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [delegatable, setDelegatable] = useState<string[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [form, setForm] = useState({
    userAccountId: '', role: '', scopeType: 'campus', scopeId: '',
  });

  const load = useCallback(() => {
    setError(null);
    apiGet<Account[]>('/v1/access/accounts').then(setAccounts)
      .catch((e: Error) => { setAccounts([]); setError(e.message); });
    apiGet<Campus[]>('/v1/campuses').then(setCampuses).catch(() => setCampuses([]));
    apiGet<Section[]>('/v1/sections').then(setSections).catch(() => setSections([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  // Re-asked whenever the scope changes, because what somebody may delegate
  // depends on where — an owner of one campus is not an owner of the school.
  useEffect(() => {
    apiGet<{ roles: string[] }>(`/v1/access/delegatable?scopeType=${form.scopeType}`)
      .then((d) => setDelegatable(d.roles))
      .catch(() => setDelegatable([]));
  }, [form.scopeType]);

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true); setError(null); setSaid(null);
    try { await fn(); setSaid(done); load(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const withAccess = (accounts ?? []).filter((a) => a.grants.length > 0).length;
  const stranded = (accounts ?? []).filter((a) => a.grants.length === 0).length;
  const departed = (accounts ?? []).filter((a) => a.left_on && a.grants.length > 0);
  const owners = (accounts ?? []).filter(
    (a) => a.grants.some((g) => g.role === 'ORG_OWNER' && g.scope_type === 'organization'));

  const needsScope = form.scopeType !== 'organization' && form.scopeType !== 'self';

  return (
    <Shell>
      <PageHead title="Access"
                lede="Who can sign in, what they can reach, and who granted it." />

      {error ? <div className="note bad">{error}</div> : null}
      {said ? <div className="note ok">{said}</div> : null}

      <div className="tiles">
        <Tile label="Accounts with access" value={String(withAccess)}
              describe="Can sign in and see something" loading={accounts === null} />
        <Tile label="No role at all" value={String(stranded)}
              describe="Can sign in and see nothing"
              tone={stranded > 0 ? 'warning' : 'good'} loading={accounts === null} />
        <Tile label="Owners" value={String(owners.length)}
              describe="School-wide"
              tone={owners.length < 2 ? 'warning' : 'good'}
              loading={accounts === null} />
        <Tile label="Left, still with access" value={String(departed.length)}
              describe="Staff who have gone"
              tone={departed.length > 0 ? 'critical' : 'good'}
              meter={departed.length > 0 ? 1 : 0}
              loading={accounts === null} />
      </div>

      {departed.length > 0 ? (
        <div className="note bad" style={{ marginTop: 16 }}>
          <strong>
            {departed.length === 1 ? 'Somebody who has left' : `${departed.length} people who have left`}
            {' '}can still sign in.
          </strong>{' '}
          A staff record marked as departed does not revoke a login — the two
          are different things on purpose, and this is the screen where the
          second one happens.
        </div>
      ) : null}

      {owners.length < 2 && accounts !== null ? (
        <div className="note" style={{ marginTop: 16 }}>
          There is one school-wide owner. If that person loses their password
          on a Sunday, nobody can grant it back — a second owner is the cheapest
          insurance this product has.
        </div>
      ) : null}

      <Panel title="Give somebody access"
             hint="The roles offered are the ones you yourself may hand out">
        <div className="row-form">
          <select value={form.userAccountId}
                  onChange={(e) => setForm((f) => ({ ...f, userAccountId: e.target.value }))}>
            <option value="">Account…</option>
            {(accounts ?? []).map((a) => (
              <option key={a.user_account_id} value={a.user_account_id}>
                {who(a)}{a.employee_code ? ` (${a.employee_code})` : ''}
              </option>
            ))}
          </select>
          <select value={form.scopeType}
                  onChange={(e) => setForm((f) => ({
                    ...f, scopeType: e.target.value, scopeId: '' }))}>
            <option value="organization">The whole school</option>
            <option value="campus">One campus</option>
            <option value="section">One section</option>
            <option value="self">Themselves only</option>
          </select>
          <select value={form.role}
                  onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
            <option value="">Role…</option>
            {delegatable.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          {needsScope ? (
            <select value={form.scopeId}
                    onChange={(e) => setForm((f) => ({ ...f, scopeId: e.target.value }))}>
              <option value="">Which one…</option>
              {form.scopeType === 'campus'
                ? campuses.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))
                : sections.map((sec) => (
                  <option key={sec.id} value={sec.id}>
                    {sec.class_name ? `${sec.class_name} ` : ''}{sec.section_name}
                  </option>
                ))}
            </select>
          ) : null}
          <button disabled={busy || !form.userAccountId || !form.role
                            || (needsScope && !form.scopeId)}
                  onClick={() => void act(() => apiPost('/v1/access/grants', {
                    userAccountId: form.userAccountId,
                    role: form.role,
                    scopeType: form.scopeType,
                    ...(needsScope ? { scopeId: form.scopeId } : {}),
                  }), 'Access granted.')}>
            Grant
          </button>
        </div>
        {delegatable.length === 0 ? (
          <p className="sub" style={{ marginTop: 8 }}>
            You hold nothing that lets you delegate at this scope.
          </p>
        ) : null}
      </Panel>

      <Panel title="Accounts" hint="One row per login, not per person on file">
        <table>
          <thead>
            <tr><th>Who</th><th>Role</th><th>Over</th><th>Since</th><th /></tr>
          </thead>
          {accounts === null ? <SkeletonRows rows={4} cols={5} /> : (
            <tbody>
              {accounts.flatMap((a) => (
                a.grants.length === 0
                  ? [(
                    <tr key={a.user_account_id}>
                      <td>
                        <strong>{who(a)}</strong>
                        {a.designation
                          ? <span className="sub" style={{ display: 'block' }}>{a.designation}</span>
                          : null}
                      </td>
                      <td colSpan={3}>
                        <span className="sub">No role — signs in and sees nothing</span>
                      </td>
                      <td />
                    </tr>
                  )]
                  : a.grants.map((g, i) => (
                    <tr key={g.id}>
                      <td>
                        {i === 0 ? (
                          <>
                            <strong>{who(a)}</strong>
                            {a.left_on
                              ? <span className="sub" style={{ display: 'block' }}>
                                  Left {a.left_on}
                                </span>
                              : a.designation
                                ? <span className="sub" style={{ display: 'block' }}>
                                    {a.designation}
                                  </span>
                                : null}
                          </>
                        ) : null}
                      </td>
                      <td>
                        <Pill tone={g.role === 'ORG_OWNER' ? 'warning' : undefined}>
                          {g.role}
                        </Pill>
                      </td>
                      <td className="sub">{SCOPE_LABEL[g.scope_type] ?? g.scope_type}</td>
                      <td className="sub">{g.granted_at.slice(0, 10)}</td>
                      <td className="n">
                        <button className="ghost" disabled={busy}
                                onClick={() => void act(
                                  () => apiPost(`/v1/access/grants/${g.id}/revoke`),
                                  'Access revoked.')}>
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))
              ))}
            </tbody>
          )}
        </table>
        {accounts?.length === 0 ? (
          <Empty title="No accounts yet">
            An account is created when somebody is invited. This screen is what
            decides which parts of the school they can then reach.
          </Empty>
        ) : null}
      </Panel>
    </Shell>
  );
}
