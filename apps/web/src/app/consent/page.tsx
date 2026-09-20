'use client';

/**
 * Consent (M32.6).
 *
 * `consentService` had no caller in `src/`. Every consent decision this system
 * enforces — and `may_message` consults one on every send — came from a row no
 * part of the product could create. A school could be refused permission to
 * message a parent who had never been asked.
 *
 * The screen is built around the gap, not around the records: a list of what
 * has been agreed is something to file, and a list of the children a school
 * does not yet have permission for is something to act on. The second is what
 * turns "thirty messages were withheld" into a morning's work with a clipboard.
 *
 * There is no "consent for everybody" button, and that absence is the design.
 * A consent record names who agreed, on whose behalf, to which version of
 * which notice, through which channel; a bulk grant would have to invent three
 * of those four, and the record would be worth nothing the day it mattered.
 */
import { useCallback, useEffect, useState } from 'react';
import { Shell, PageHead } from '../shell';
import { Empty, Panel, Pill, SkeletonRows, Tile } from '@/components/ui';
import { apiGet, apiPost } from '@/lib/api';

interface Notice {
  id: string; code: string; version: number; locale: string;
  title: string; published_at: string;
}
interface Gap {
  student_id: string; admission_no: string; person_id: string;
  given_name: string; family_name: string | null;
  section_name: string | null; class_name: string | null;
  guardian_person_id: string | null; guardian_given_name: string | null;
  guardian_link_id: string | null;
}

const PURPOSES = [
  { value: 'attendance_notifications', label: 'Attendance messages' },
  { value: 'fee_notifications', label: 'Fee reminders' },
  { value: 'photo_publication', label: 'Publishing photographs' },
  { value: 'transport_tracking', label: 'Bus tracking' },
  { value: 'third_party_assessment', label: 'Third-party assessments' },
  { value: 'marketing', label: 'Marketing' },
] as const;

/**
 * Deliberately not in the list above.
 *
 * Delivering the education a family is paying for is not consent-based, so
 * there is no consent to collect and none to withdraw. Offering it as a toggle
 * would be offering something the law does not — and the service refuses it
 * anyway, which is the right place for the rule but the wrong place for a
 * family to discover it.
 */
const CONTRACT_BASIS = 'core_education_service';

export default function ConsentPage() {
  const [notices, setNotices] = useState<Notice[] | null>(null);
  const [gaps, setGaps] = useState<Gap[] | null>(null);
  const [purpose, setPurpose] = useState<string>('attendance_notifications');
  const [noticeId, setNoticeId] = useState('');
  const [channel, setChannel] = useState<'paper' | 'in_person' | 'app' | 'web'>('paper');
  const [evidence, setEvidence] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    setGaps(null);
    apiGet<Notice[]>('/v1/consent/notices')
      .then((n) => {
        setNotices(n);
        setNoticeId((current) => current || n[0]?.id || '');
      })
      .catch((e: Error) => { setNotices([]); setError(e.message); });
    apiGet<Gap[]>(`/v1/consent/gaps?purpose=${purpose}`)
      .then(setGaps)
      .catch((e: Error) => { setGaps([]); setError(e.message); });
  }, [purpose]);
  useEffect(() => { load(); }, [load]);

  async function record(g: Gap) {
    if (!g.guardian_person_id) return;
    setBusy(true); setError(null); setSaid(null);
    try {
      await apiPost('/v1/consent', {
        personId: g.person_id,
        givenByPersonId: g.guardian_person_id,
        purpose,
        noticeVersionId: noticeId,
        channel,
        ...(g.guardian_link_id ? { guardianLinkId: g.guardian_link_id } : {}),
        ...(evidence ? { evidenceRef: evidence } : {}),
      });
      setSaid(`Recorded for ${g.given_name}.`);
      load();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const unreachable = (gaps ?? []).filter((g) => !g.guardian_person_id).length;
  const label = PURPOSES.find((p) => p.value === purpose)?.label ?? purpose;

  return (
    <Shell>
      <PageHead title="Consent"
                lede="What families have agreed to, and who has never been asked." />

      {error ? <div className="note bad">{error}</div> : null}
      {said ? <div className="note ok">{said}</div> : null}

      <div className="tiles">
        <Tile label="Not yet asked" value={String(gaps?.length ?? 0)}
              describe={label}
              tone={(gaps?.length ?? 0) > 0 ? 'warning' : 'good'}
              loading={gaps === null} />
        <Tile label="No guardian on file" value={String(unreachable)}
              describe="Nobody to ask"
              tone={unreachable > 0 ? 'critical' : 'good'}
              loading={gaps === null} />
        <Tile label="Published notices" value={String(notices?.length ?? 0)}
              describe="Versions a record can point at"
              tone={(notices?.length ?? 0) === 0 ? 'critical' : 'good'}
              loading={notices === null} />
      </div>

      {notices !== null && notices.length === 0 ? (
        <div className="note bad" style={{ marginTop: 16 }}>
          <strong>No notice has been published.</strong>{' '}
          A consent record points at the exact text somebody agreed to, so
          nothing can be recorded until there is one. "They said yes" is not a
          record anybody can stand behind three years later.
        </div>
      ) : null}

      <Panel
        title={`Nobody has asked about: ${label}`}
        hint="This is the list that turns thirty withheld messages into a
              morning's work"
        actions={
          <select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
            {PURPOSES.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        }
      >
        <div className="row-form" style={{ marginBottom: 12 }}>
          <select value={noticeId} onChange={(e) => setNoticeId(e.target.value)}>
            <option value="">Notice…</option>
            {(notices ?? []).map((n) => (
              <option key={n.id} value={n.id}>
                {n.title} v{n.version} ({n.locale})
              </option>
            ))}
          </select>
          <select value={channel}
                  onChange={(e) => setChannel(e.target.value as typeof channel)}>
            <option value="paper">On paper</option>
            <option value="in_person">In person</option>
            <option value="app">In the app</option>
            <option value="web">On the website</option>
          </select>
          <input type="text" style={{ flex: 1 }}
                 placeholder="Where the signed form is — a file reference"
                 value={evidence} onChange={(e) => setEvidence(e.target.value)} />
        </div>

        <table>
          <thead>
            <tr><th>Learner</th><th>Class</th><th>Who would agree</th><th /></tr>
          </thead>
          {gaps === null ? <SkeletonRows rows={4} cols={4} /> : (
            <tbody>
              {gaps.map((g) => (
                <tr key={g.student_id}>
                  <td>
                    <strong>
                      {g.given_name}{g.family_name ? ` ${g.family_name}` : ''}
                    </strong>
                    <span className="sub" style={{ display: 'block' }}>
                      {g.admission_no}
                    </span>
                  </td>
                  <td>
                    {g.class_name ? `${g.class_name} ` : ''}
                    {g.section_name ?? <span className="sub">Not in a class</span>}
                  </td>
                  <td>
                    {g.guardian_given_name
                      ?? <Pill tone="critical">No guardian linked</Pill>}
                  </td>
                  <td className="n">
                    {g.guardian_person_id ? (
                      <button className="ghost"
                              disabled={busy || !noticeId}
                              onClick={() => void record(g)}>
                        Record consent
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          )}
        </table>
        {gaps?.length === 0 ? (
          <Empty title={`Every learner is covered for ${label.toLowerCase()}`}>
            Nothing to collect. A family can still withdraw at any time, and
            the send path reads the answer at the moment it sends rather than
            when the list was built.
          </Empty>
        ) : null}
      </Panel>

      <Panel title="What cannot be switched off"
             hint="Not an omission from the list above">
        <p className="sub">
          Delivering the education a family is paying for — attendance
          registers, marks, the records a school is required to keep — is not
          consent-based processing, so there is no consent to collect for it and
          none to withdraw. The API refuses a withdrawal of{' '}
          <code>{CONTRACT_BASIS}</code> and says that closing the account is the
          way to end it. Offering the toggle here would be offering something
          the law does not.
        </p>
      </Panel>
    </Shell>
  );
}
