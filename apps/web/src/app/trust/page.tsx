'use client';

import { useCallback, useEffect, useState } from 'react';
import { Shell, PageHead } from '../shell';
import { Panel, Pill, Icon, Empty, SkeletonRows } from '@/components/ui';
import { apiGet, apiPost, ApiError } from '@/lib/api';

/**
 * The trust page.
 *
 * Two sections, and the second is the one that makes the first worth reading.
 *
 * Everything under "What is enforced" names the mechanism that enforces it, so
 * a reader can go and check rather than take our word. Everything under "What
 * we do not claim" is a thing a competitor's page would assert and we cannot,
 * because the product is not deployed anywhere yet. A trust page that lists
 * only strengths is marketing; the absent section is where the trust is.
 */

interface Claim { what: string; how: string; where: string }

const ENFORCED: Array<{ heading: string; lede: string; claims: Claim[] }> = [
  {
    heading: 'One school cannot see another',
    lede: 'Isolation is a database policy, not a WHERE clause somebody remembers to write.',
    claims: [
      {
        what: 'Every table holding school data carries a row-level security policy, forced.',
        how: 'Forced RLS applies to the table owner too, so there is no role that quietly sees everything.',
        where: 'A coverage view lists every table with a tenant column; a test fails if any lacks a policy.',
      },
      {
        what: 'The application cannot turn isolation off.',
        how: 'The API asserts at boot that its database role is neither superuser nor BYPASSRLS, and refuses to start otherwise.',
        where: 'assertAppRoleCannotBypassRls(), run before the first request is served.',
      },
      {
        what: 'The tenant is never read from a request header.',
        how: 'It comes from the verified access token or the API key, and is set as a transaction-local setting the policies read.',
        where: 'A header-settable tenant was removed deliberately and has not come back.',
      },
    ],
  },
  {
    heading: 'Credentials are held where the application cannot reach them',
    lede: 'Two database roles, and the one that serves your data cannot read a secret.',
    claims: [
      {
        what: 'Password hashes are unreadable by the role that serves school data.',
        how: 'A second role, used only by login, holds that access. A flaw in a reporting query cannot reach a credential.',
        where: 'Asserted at boot: the auth role must have no privilege on tenant tables.',
      },
      {
        what: 'Passwords are hashed with Argon2id.',
        how: 'Not a fast hash. A stolen hash is not a password.',
        where: 'The same hasher runs for seeded demo accounts, so there is no bypass path to drift from.',
      },
      {
        what: 'An API key secret is stored only as a hash and shown exactly once.',
        how: '256 bits from a CSPRNG. There is no endpoint that reads one back — a secret an API can re-read is a secret in every log that captured that response.',
        where: 'Its table has no grant at all to the application role.',
      },
      {
        what: 'A webhook signing secret is never loaded into application memory.',
        how: 'Column-level grants mean a SELECT * on that table raises permission denied. Signing happens inside the database.',
        where: 'webhook_sign(), the only path to a signature.',
      },
    ],
  },
  {
    heading: 'People see only what their role justifies',
    lede: 'Including inside one school — most data exposure is internal.',
    claims: [
      {
        what: 'A parent sees their own children and nobody else’s.',
        how: 'Enforced by policy on a trigger-maintained projection, not by a caller-supplied "I am a guardian" flag.',
        where: 'The failure mode is closed: an unknown caller sees nothing, rather than everything.',
      },
      {
        what: 'A teacher cannot see fees at all.',
        how: 'Finance scope is deliberately narrower than staff scope. A class teacher who knows which families are behind treats those children differently.',
        where: 'app_actor_has_finance_scope(), separate from staff scope since the day a test found a teacher reading seven invoices.',
      },
      {
        what: 'An internal note on a support ticket is invisible to the person who raised it.',
        how: 'Filtered by policy rather than by the query, because a note rendered to a parent cannot be recalled.',
        where: 'ticket_message, thread_visibility policy.',
      },
      {
        what: 'An API key acts as itself and can never manage integrations.',
        how: 'A credential that can mint credentials or redirect the event stream can escalate itself, so integration scope has no machine branch at all.',
        where: 'app_actor_has_integration_scope().',
      },
    ],
  },
  {
    heading: 'The record cannot be quietly rewritten',
    lede: 'What happened stays what happened.',
    claims: [
      {
        what: 'Invoices, payments and receipts are never edited or deleted.',
        how: 'An invoice is voided with a reason and keeps its number. A gap in a sequence is what an auditor asks about.',
        where: 'Database triggers, not application convention.',
      },
      {
        what: 'Audit entries, support threads and webhook attempts are append-only.',
        how: 'A correction is a new row that supersedes, never an overwrite.',
        where: 'Triggers that raise on UPDATE or DELETE, provable by trying it.',
      },
      {
        what: 'A published result is corrected by superseding, and the old version is retained.',
        how: 'A report card that changed silently is one a family cannot reason about.',
        where: 'report_card versioning.',
      },
    ],
  },
  {
    heading: 'Consent is read when the message is sent',
    lede: 'Not when the list was built.',
    claims: [
      {
        what: 'A parent who withdraws consent this morning is not messaged this afternoon.',
        how: 'Consent is re-read per recipient, per purpose, at the moment of sending — not at the moment the audience was computed.',
        where: 'may_message(), called per recipient inside the dispatcher.',
      },
      {
        what: 'A message that is not sent is recorded as suppressed, with the reason.',
        how: '"We did not message you because you withdrew consent on the 4th" is an answer. An absent row is not.',
        where: 'message_recipient, suppression reason.',
      },
      {
        what: 'A webhook endpoint cannot point inside our network.',
        how: 'Checked against every resolved address, not the hostname — a hostname blocklist is defeated by a free DNS record.',
        where: 'url-safety.ts, and https is a column constraint.',
      },
    ],
  },
];

const PLATFORM_ACCESS_SECTION: { heading: string; lede: string; claims: Claim[] } = {
  heading: 'paathshalaOS staff can enter your school — and cannot do it quietly',
  lede: 'Stated plainly, because the honest version is more reassuring than a vague one.',
  claims: [
    {
      what: 'A member of our staff can enter your school as one of your people, in one click.',
      how: 'No second approver and no waiting. We decided that an approval queue between two colleagues who sit together becomes a rubber stamp in a week, and a rubber stamp is worse than nothing because it looks like a control.',
      where: 'The panel above lists every time it has happened, live.',
    },
    {
      what: 'They enter as a named person, and see exactly what that person sees.',
      how: 'The session borrows that person\'s identity for the database, so your own access rules decide what is visible. There is no privileged view that shows more than any of your staff can see.',
      where: 'The token names the person; the access log above names them too.',
    },
    {
      what: 'Looking and changing are separate permissions.',
      how: 'A session is read-only unless the person holds a second capability and asks for write when they enter. A read-only session is refused by the API on every request that would change anything, not just in the interface.',
      where: 'The "could change records" mark in the log above is the difference.',
    },
    {
      what: 'An hour is the maximum, enforced by the database.',
      how: 'A trigger refuses to store a session longer than sixty minutes, so a second code path cannot grant itself a longer one. The default is thirty.',
      where: 'Expiry is re-checked on every request, not on a timer.',
    },
    {
      what: 'You can end a session while it is running.',
      how: 'It stops on their next request — not when their token happens to expire.',
      where: 'The "End it" button above.',
    },
    {
      what: 'Everything done inside carries both names.',
      how: 'Each audit entry records the member of our staff who was at the keyboard and the person whose identity was borrowed. A change never appears under your colleague\'s name alone.',
      where: 'Your audit trail, not ours — we write it into your school\'s records.',
    },
  ],
};

const NOT_CLAIMED: Array<{ what: string; why: string }> = [
  {
    what: 'A hosting region, or anything about production infrastructure.',
    why: 'This product is not deployed. The intended region is India; that is a plan, not a fact, and a trust page is the wrong place for plans.',
  },
  {
    what: 'Encryption at rest, or in transit, in production.',
    why: 'Both are table stakes and both are properties of a deployment that does not exist yet.',
  },
  {
    what: 'Backups, restore testing, or a recovery objective.',
    why: 'Nothing is configured. An untested backup is a claim, not a backup.',
  },
  {
    what: 'ISO 27001, SOC 2, or any certification.',
    why: 'None held, none in progress.',
  },
  {
    what: 'A penetration test or external security review.',
    why: 'None has been carried out. The isolation suite is our own test of our own assumptions, which is not the same thing.',
  },
  {
    what: 'Compliance with the DPDP Act or any other statute.',
    why: 'Specific mechanisms here — consent at send time, retention rules, an append-only audit trail — were built with it in mind. Whether the whole is compliant is a judgement for a lawyer looking at a real deployment, not a badge we can award ourselves.',
  },
  {
    what: 'A list of sub-processors.',
    why: 'There are none, because nothing is running. This section becomes a table the day that changes.',
  },
];

export default function TrustPage() {
  return (
    <Shell>
      <PageHead
        title="Trust"
        lede="What this system enforces, how, and where to check it — followed by what it does not yet claim."
      />

      <div className="note" style={{ marginBottom: 14 }}>
        <span>
          Every line in the first half names the mechanism behind it. Nothing here
          asks you to take our word — the point of naming the enforcement is that
          you can go and read it.
        </span>
      </div>

      <PlatformAccess />

      {[PLATFORM_ACCESS_SECTION, ...ENFORCED].map((section) => (
        <Panel key={section.heading} title={section.heading} hint={section.lede}>
          <ul className="claims">
            {section.claims.map((c) => (
              <li key={c.what}>
                <span className="mark" aria-hidden="true"><Icon.check /></span>
                <div>
                  <strong>{c.what}</strong>
                  <span className="sub" style={{ display: 'block' }}>{c.how}</span>
                  <span className="where">{c.where}</span>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      ))}

      <Panel
        title="What we do not claim"
        hint="A trust page that lists only strengths is a brochure"
        actions={<Pill tone="warning">{NOT_CLAIMED.length} items</Pill>}
      >
        <ul className="claims open">
          {NOT_CLAIMED.map((c) => (
            <li key={c.what}>
              <span className="mark" aria-hidden="true" />
              <div>
                <strong>{c.what}</strong>
                <span className="sub" style={{ display: 'block' }}>{c.why}</span>
              </div>
            </li>
          ))}
        </ul>
        <div className="caption">
          <Icon.check />
          This list shrinks as things become true, and never by rewording.
        </div>
      </Panel>

      <Panel title="Reporting something" hint="Where a security problem should go">
        <div className="prose">
          <p>
            Security reports go to <code>security@paathshala.os</code>. There is no
            bounty programme and we will not pretend otherwise; there is a person
            who reads that address and will tell you what happened next.
          </p>
          <p className="sub">
            Contact address not yet publicly verified — this product has no
            production deployment, so treat it as the intended route rather than a
            monitored inbox.
          </p>
        </div>
      </Panel>
    </Shell>
  );
}


/* --------------------------------------------------- platform access (M15) */

interface AccessRow {
  id: string;
  actor_email: string | null;
  target_email: string | null;
  assumed_role: string | null;
  entry_path: string;
  status: string;
  reason: string;
  write_enabled: boolean;
  started_at: string | null;
  expires_at: string | null;
}

/**
 * The school's own view of every time we have been in their records.
 *
 * This panel is what makes the rest of this page more than assertion. Anybody
 * can write "we only access your data for support"; this is the school reading
 * the log and holding the button that ends a session while it is running.
 *
 * It lives on Trust rather than in Settings on purpose. Settings is where
 * things go to be configured once and never looked at; this wants to be seen.
 */
function PlatformAccess() {
  const [rows, setRows] = useState<AccessRow[] | null>(null);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    apiGet<AccessRow[]>('/v1/platform-access')
      .then(setRows)
      .catch((e: ApiError) => {
        // 404 is what somebody without audit:read gets, and it is not an error
        // worth shouting about — the panel simply is not theirs.
        if (e.status === 404) setDenied(true);
        setRows([]);
      });
  }, []);

  useEffect(load, [load]);

  if (denied) return null;

  const live = (rows ?? []).filter((r) => r.status === 'active');

  async function end(id: string) {
    setBusy(id);
    try {
      await apiPost(`/v1/platform-access/${id}/end`, {});
      load();
    } finally {
      setBusy(null);
    }
  }

  const when = (value: string | null) =>
    value ? new Date(value).toLocaleString('en-IN',
      { dateStyle: 'medium', timeStyle: 'short' }) : '—';

  return (
    <Panel
      title="Who from paathshalaOS has been in your records"
      hint="Every session, why it was opened, and who it was opened as. You can end one while it is running."
      actions={live.length > 0
        ? <Pill tone="critical">{live.length} open now</Pill>
        : <Pill tone="good">nobody here now</Pill>}
    >
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Who</th><th>As</th><th>Why</th><th>Started</th><th>State</th><th />
            </tr>
          </thead>
          {rows === null ? <SkeletonRows cols={6} /> : rows.length === 0 ? (
            <tbody>
              <tr>
                <td colSpan={6}>
                  <Empty title="Nobody from paathshalaOS has entered this school">
                    If that changes, it appears here while it is happening.
                  </Empty>
                </td>
              </tr>
            </tbody>
          ) : (
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.actor_email ?? 'paathshalaOS staff'}</td>
                  <td>
                    {r.target_email ?? '—'}
                    {r.assumed_role ? <span className="sub"> ({r.assumed_role})</span> : null}
                    {r.write_enabled ? <> <Pill tone="critical">could change records</Pill></> : null}
                  </td>
                  <td className="reason" title={r.reason}>{r.reason}</td>
                  <td>{when(r.started_at)}</td>
                  <td>
                    <Pill tone={r.status === 'active' ? 'critical' : undefined}>{r.status}</Pill>
                  </td>
                  <td className="num">
                    {r.status === 'active' ? (
                      <button className="ghost" disabled={busy === r.id}
                              onClick={() => end(r.id)}>
                        {busy === r.id ? 'Ending…' : 'End it'}
                      </button>
                    ) : null}
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
