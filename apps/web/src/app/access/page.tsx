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
import { Empty, Panel, Pill, Tile } from '@/components/ui';
import { apiGet, apiPost } from '@/lib/api';
import { DataTable } from '@/components/data-table';
import { ConfirmButton } from '@/components/confirm';

interface Grant {
  id: string; role: string; scope_type: string; scope_id: string | null;
  granted_at: string; expires_at: string | null;
}
interface Account {
  user_account_id: string; person_id: string | null;
  given_name: string | null; family_name: string | null;
  employee_code: string | null; designation: string | null;
  left_on: string | null;
  /** What they have stated, or null — see `languageCell`. */
  locale: string | null;
  grants: Grant[];
}
interface Campus { id: string; name: string }
interface LocaleOption { tag: string; english: string; endonym?: string }
interface Section { id: string; section_name: string; class_name: string | null }

const SCOPE_LABEL: Record<string, string> = {
  organization: 'the whole school',
  campus: 'one campus',
  academic_unit: 'one academic unit',
  class_group: 'one class',
  section: 'one section',
  self: 'themselves only',
};

interface AccessRow { account: Account; grant: Grant | null }

/** One row per role held; an account with none still gets one. */
function accessRows(accounts: Account[]): AccessRow[] {
  return accounts.flatMap<AccessRow>((account) => (account.grants.length === 0
    ? [{ account, grant: null }]
    : account.grants.map((grant) => ({ account, grant }))));
}

const who = (a: Account) =>
  [a.given_name, a.family_name].filter(Boolean).join(' ') || 'Unnamed account';

export default function AccessPage() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [delegatable, setDelegatable] = useState<string[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [locales, setLocales] = useState<LocaleOption[]>([]);
  /** Local echo of a change, so the select does not snap back while it saves. */
  const [spoken, setSpoken] = useState<Record<string, string>>({});
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
    apiGet<{ options: LocaleOption[] }>('/v1/locale')
      .then((v) => setLocales(v.options)).catch(() => setLocales([]));
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

  /**
   * The language this person is written to in (M29.3).
   *
   * Here, on the account list, because a language is a property of a reader
   * and this is the screen that says who the readers are. It is also the only
   * place the office can set it for somebody else — and that is not a
   * workaround: a parent who cannot read the app cannot reach the screen that
   * changes its language, which is the whole problem. The admissions desk
   * setting it while the family is standing there is the only version of this
   * that reaches the families who need it most.
   *
   * Blank means they have stated nothing, and the school's own language
   * answers for them. That is shown as an empty choice rather than the
   * school's tag, because "unset" and "chose the same as the school" are
   * different facts and the first one changes when the school's does.
   */
  function languageCell(a: Account) {
    if (!a.person_id) return <span className="sub">—</span>;
    const personId = a.person_id;
    return (
      <select value={spoken[personId] ?? a.locale ?? ''} disabled={busy}
              onChange={(e) => {
                const locale = e.target.value;
                // Blank is "they have stated nothing", which is a state the
                // API has no way to return to — there is no un-say. Offering
                // it as a choice that silently fails would be worse than
                // offering it as the label for a person who has not chosen.
                if (!locale) return;
                setSpoken((m) => ({ ...m, [personId]: locale }));
                void act(() => apiPost(`/v1/locale/people/${personId}`, { locale }),
                  'Language set.');
              }}>
        <option value="">Whatever the school uses</option>
        {locales.map((l) => (
          <option key={l.tag} value={l.tag}>
            {l.endonym ? `${l.english} (${l.endonym})` : l.english}
          </option>
        ))}
      </select>
    );
  }

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

      <DataTable<AccessRow>
        id="access-accounts"
        title="Accounts"
        rows={accounts === null ? null : accessRows(accounts)}
        rowKey={(r) => r.grant?.id ?? r.account.user_account_id}
        empty={(
          <Empty title="No accounts yet">
            An account is created when somebody is invited. This screen is what
            decides which parts of the school they can then reach.
          </Empty>
        )}
        columns={[
          // One row per role held, so a filter for "TEACHER" finds everybody
          // who is one. Somebody with no role still gets a row: an account
          // that signs in and sees nothing is worth seeing here.
          { key: 'who', label: 'Who', required: true, text: (r) => who(r.account),
            render: (r) => (
              <>
                <strong>{who(r.account)}</strong>
                {r.account.left_on
                  ? <span className="sub" style={{ display: 'block' }}>Left {r.account.left_on}</span>
                  : r.account.designation
                    ? <span className="sub" style={{ display: 'block' }}>{r.account.designation}</span>
                    : null}
              </>
            ) },
          { key: 'role', label: 'Role', text: (r) => r.grant?.role ?? 'No role',
            render: (r) => (r.grant
              ? <Pill tone={r.grant.role === 'ORG_OWNER' ? 'warning' : undefined}>{r.grant.role}</Pill>
              : <span className="sub">No role — signs in and sees nothing</span>) },
          { key: 'over', label: 'Over',
            text: (r) => r.grant ? (SCOPE_LABEL[r.grant.scope_type] ?? r.grant.scope_type) : '' },
          { key: 'since', label: 'Since', text: (r) => r.grant?.granted_at.slice(0, 10) ?? '' },
          { key: 'expires', label: 'Expires', optional: true,
            text: (r) => r.grant?.expires_at?.slice(0, 10) ?? '' },
          { key: 'code', label: 'Employee code', optional: true,
            text: (r) => r.account.employee_code ?? '' },
          { key: 'reads', label: 'Reads', action: true, text: () => '',
            render: (r) => languageCell(r.account) },
          { key: 'revoke', label: '', action: true, align: 'right', text: () => '',
            render: (r) => (r.grant ? (
              <ConfirmButton label="Revoke" confirmLabel="Revoke access?" tone="critical"
                             disabled={busy}
                             onConfirm={() => act(
                               () => apiPost(`/v1/access/grants/${r.grant!.id}/revoke`),
                               'Access revoked.')} />
            ) : null) },
        ]}
      />
    </Shell>
  );
}
