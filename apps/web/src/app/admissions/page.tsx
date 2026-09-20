'use client';

/**
 * Admissions (M32.2).
 *
 * M5 built the whole pipeline and no way to walk it. This is the walk, in the
 * order an office actually does it: somebody rings, somebody comes in with a
 * form, somebody decides, a family says yes, and a child appears on the roll.
 *
 * Enquiries and applications are one table on screen even though they are two
 * in the database, because an office does not think about which table a family
 * is in — it thinks about who it has heard from and what happens next. A screen
 * that makes somebody check two places is a screen where the second place stops
 * getting checked.
 */
import { useCallback, useEffect, useState } from 'react';
import { Shell, PageHead } from '../shell';
import { Empty, Panel, Pill, SkeletonRows, Tile } from '@/components/ui';
import { apiGet, apiPost } from '@/lib/api';

interface Row {
  kind: 'enquiry' | 'application';
  id: string; person_id: string | null; name: string;
  phone: string | null; programme_name: string | null;
  stage: string; application_no: string | null;
  decision_id: string | null; outcome: string | null;
  offered_section: string | null; offer_expires_at: string | null;
  accepted_at: string | null; declined_at: string | null;
  enrolled: boolean; created_at: string;
}
interface FormDef {
  id: string; code: string; version: number; title: string; json_schema: unknown;
}

/** One field, as the form's own JSON Schema describes it. */
interface Field {
  key: string; label: string; required: boolean;
  type: 'string' | 'number' | 'integer' | 'boolean';
  options: string[] | null;
}

/**
 * The form's fields, read off the schema it was published with.
 *
 * The first version of this screen had a single box for the answers as raw
 * JSON. That is honest about what the API takes and useless to the person it
 * is for: nobody at an admissions counter types `{"previousSchool":"…"}`, and
 * a malformed brace is a refused application with a family standing there.
 *
 * Reading the schema means the fields are whatever THIS school asked for,
 * which is the entire reason the form is configurable. Anything the renderer
 * does not understand — a nested object, an array — falls back to the JSON box
 * rather than being silently dropped, because dropping an answer is worse than
 * asking somebody to type one.
 */
function fieldsOf(form: FormDef | undefined): { fields: Field[]; renderable: boolean } {
  const schema = form?.json_schema as {
    properties?: Record<string, {
      type?: string; title?: string; enum?: unknown[]; description?: string;
    }>;
    required?: string[];
  } | undefined;
  if (!schema?.properties) return { fields: [], renderable: false };

  const required = new Set(schema.required ?? []);
  const fields: Field[] = [];
  let renderable = true;

  for (const [key, spec] of Object.entries(schema.properties)) {
    const type = spec.type ?? 'string';
    if (!['string', 'number', 'integer', 'boolean'].includes(type)) {
      renderable = false;
      continue;
    }
    fields.push({
      key,
      // A schema that bothered to give a title has said how to label it.
      // Otherwise `previousSchool` becomes `Previous school` rather than being
      // shown to a parent as camelCase.
      label: spec.title ?? key.replace(/([A-Z])/g, ' $1')
        .replace(/^./, (c) => c.toUpperCase()).trim(),
      required: required.has(key),
      type: type as Field['type'],
      options: Array.isArray(spec.enum) ? spec.enum.map(String) : null,
    });
  }
  return { fields, renderable };
}
interface Section { id: string; section_name: string; class_name: string | null }
interface Programme { id: string; name: string }
interface Campus { id: string; name: string }
interface Year { id: string; label: string; status: string }

/**
 * What happens next, in one phrase.
 *
 * The stage column is the whole point of the screen, so it is computed from
 * the row rather than printed from the database's own vocabulary. "submitted"
 * tells somebody what state a record is in; "waiting for a decision" tells
 * them whose turn it is.
 */
function nextStep(r: Row): { text: string; tone?: 'good' | 'warning' | 'critical' } {
  if (r.enrolled) return { text: 'On the roll', tone: 'good' };
  if (r.declined_at) return { text: 'Family declined' };
  if (r.accepted_at) return { text: 'Accepted — not yet enrolled', tone: 'warning' };
  if (r.outcome === 'offered') {
    const left = r.offer_expires_at
      ? Math.ceil((new Date(r.offer_expires_at).getTime() - Date.now()) / 86_400_000)
      : null;
    if (left !== null && left < 0) return { text: 'Offer lapsed', tone: 'critical' };
    return {
      text: left === null ? 'Offered' : `Offered — ${left}d to reply`,
      tone: left !== null && left <= 3 ? 'warning' : undefined,
    };
  }
  if (r.outcome === 'waitlisted') return { text: 'Waitlisted' };
  if (r.outcome === 'rejected') return { text: 'Not offered' };
  if (r.kind === 'enquiry') return { text: 'Enquiry — no form yet', tone: 'warning' };
  return { text: 'Waiting for a decision', tone: 'warning' };
}

export default function AdmissionsPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [forms, setForms] = useState<FormDef[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [programmes, setProgrammes] = useState<Programme[]>([]);
  const [years, setYears] = useState<Year[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [enquiry, setEnquiry] = useState({
    name: '', phone: '', source: 'phone', programmeId: '', note: '',
  });
  const [intake, setIntake] = useState({
    givenName: '', familyName: '', dateOfBirth: '', programmeId: '',
    formDefinitionId: '', answers: '{}', enquiryId: '',
  });
  const [answers, setAnswers] = useState<Record<string, string | boolean>>({});
  const [offerSection, setOfferSection] = useState<Record<string, string>>({});

  const year = years.find((y) => y.status === 'active') ?? years[0];

  const load = useCallback(() => {
    setError(null);
    apiGet<Row[]>('/v1/admissions/pipeline').then(setRows)
      .catch((e: Error) => { setRows([]); setError(e.message); });
    apiGet<FormDef[]>('/v1/admissions/forms').then(setForms).catch(() => setForms([]));
    apiGet<Section[]>('/v1/sections').then(setSections).catch(() => setSections([]));
    apiGet<Year[]>('/v1/academic-years').then(setYears).catch(() => setYears([]));
    apiGet<Programme[]>('/v1/programmes').then(setProgrammes).catch(() => setProgrammes([]));
    apiGet<Campus[]>('/v1/campuses').then(setCampuses).catch(() => setCampuses([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true); setError(null); setSaid(null);
    try { await fn(); setSaid(done); load(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }

  const chosenForm = forms.find((f) => f.id === intake.formDefinitionId);
  const { fields, renderable } = fieldsOf(chosenForm);

  const enquiries = (rows ?? []).filter((r) => r.kind === 'enquiry').length;
  const undecided = (rows ?? []).filter(
    (r) => r.kind === 'application' && !r.outcome).length;
  const awaitingFamily = (rows ?? []).filter(
    (r) => r.outcome === 'offered' && !r.accepted_at && !r.declined_at).length;
  const enrolled = (rows ?? []).filter((r) => r.enrolled).length;

  return (
    <Shell>
      <PageHead title="Admissions"
                lede="From the first phone call to a name on the roll." />

      {error ? <div className="note bad">{error}</div> : null}
      {said ? <div className="note ok">{said}</div> : null}

      <div className="tiles">
        <Tile label="Open enquiries" value={String(enquiries)}
              describe="No form yet" tone={enquiries > 0 ? 'warning' : 'good'}
              loading={rows === null} />
        <Tile label="Waiting on us" value={String(undecided)}
              describe="Applications undecided"
              tone={undecided > 0 ? 'warning' : 'good'} loading={rows === null} />
        <Tile label="Waiting on the family" value={String(awaitingFamily)}
              describe="Offers out" loading={rows === null} />
        {/* Counts families who came through THIS pipeline, not the roll —
            a school migrating in forty existing learners has not admitted
            them, and a tile reading 40 on day one would say it had. */}
        <Tile label="On the roll" value={String(enrolled)}
              describe="Admitted through here" loading={rows === null} />
      </div>

      {forms.length === 0 ? (
        <div className="note bad" style={{ marginTop: 16 }}>
          <strong>There is no published admission form.</strong>{' '}
          Nothing can be taken in until there is one — an application carries the
          answer set that produced it, so it can be reproduced years later.
        </div>
      ) : null}

      <Panel title="Pipeline" hint="Enquiries and applications, in the order they arrived">
        <table>
          <thead>
            <tr>
              <th>Who</th><th>Programme</th><th>Reference</th>
              <th>What happens next</th><th />
            </tr>
          </thead>
          {rows === null ? <SkeletonRows rows={4} cols={5} /> : (
            <tbody>
              {rows.map((r) => {
                const step = nextStep(r);
                return (
                  <tr key={r.id}>
                    <td>
                      <strong>{r.name}</strong>
                      {r.phone
                        ? <span className="sub" style={{ display: 'block' }}>{r.phone}</span>
                        : null}
                    </td>
                    <td>{r.programme_name ?? <span className="sub">—</span>}</td>
                    <td>
                      {r.application_no ?? <span className="sub">Enquiry</span>}
                      {r.offered_section
                        ? <span className="sub" style={{ display: 'block' }}>
                            Offered {r.offered_section}
                          </span>
                        : null}
                    </td>
                    <td>
                      {step.tone
                        ? <Pill tone={step.tone}>{step.text}</Pill>
                        : <Pill>{step.text}</Pill>}
                    </td>
                    <td className="num">
                      {r.kind === 'enquiry' ? (
                        <button className="ghost"
                                onClick={() => setIntake((f) => ({
                                  ...f, enquiryId: r.id,
                                  givenName: f.givenName || r.name.split(' ')[0] || '',
                                }))}>
                          Take the form
                        </button>
                      ) : null}

                      {r.kind === 'application' && !r.outcome ? (
                        <div className="row-form" style={{ justifyContent: 'flex-end' }}>
                          <select value={offerSection[r.id] ?? ''}
                                  onChange={(e) => setOfferSection(
                                    (m) => ({ ...m, [r.id]: e.target.value }))}>
                            <option value="">Section…</option>
                            {sections.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.class_name ? `${s.class_name} ` : ''}{s.section_name}
                              </option>
                            ))}
                          </select>
                          <button className="ghost"
                                  disabled={busy || !offerSection[r.id]}
                                  onClick={() => void act(() => apiPost(
                                    `/v1/admissions/applications/${r.id}/decide`, {
                                      outcome: 'offered',
                                      offeredSectionId: offerSection[r.id],
                                      offerValidDays: 14,
                                    }), 'Offer made.')}>
                            Offer a place
                          </button>
                          <button className="ghost" disabled={busy}
                                  onClick={() => void act(() => apiPost(
                                    `/v1/admissions/applications/${r.id}/decide`, {
                                      outcome: 'waitlisted',
                                    }), 'Waitlisted.')}>
                            Waitlist
                          </button>
                        </div>
                      ) : null}

                      {r.decision_id && r.outcome === 'offered'
                        && !r.accepted_at && !r.declined_at ? (
                        <>
                          <button className="ghost" disabled={busy}
                                  onClick={() => void act(() => apiPost(
                                    `/v1/admissions/decisions/${r.decision_id}/accept`,
                                    {}), 'Enrolled.')}>
                            Family accepted
                          </button>{' '}
                          <button className="ghost" disabled={busy}
                                  onClick={() => void act(() => apiPost(
                                    `/v1/admissions/decisions/${r.decision_id}/decline`,
                                    {}), 'Recorded.')}>
                            Declined
                          </button>
                        </>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          )}
        </table>
        {rows?.length === 0 ? (
          <Empty title="Nothing in the pipeline">
            An enquiry is a name and a phone number. That is enough to start.
          </Empty>
        ) : null}
      </Panel>

      <Panel title="Somebody rang" hint="A name and a number beats a note on paper">
        <div className="row-form">
          <input type="text" placeholder="Name" value={enquiry.name}
                 onChange={(e) => setEnquiry((f) => ({ ...f, name: e.target.value }))} />
          <input type="text" placeholder="Phone" value={enquiry.phone}
                 onChange={(e) => setEnquiry((f) => ({ ...f, phone: e.target.value }))} />
          <select value={enquiry.source}
                  onChange={(e) => setEnquiry((f) => ({ ...f, source: e.target.value }))}>
            <option value="phone">Phone</option>
            <option value="walk_in">Walked in</option>
            <option value="website">Website</option>
            <option value="referral">Referral</option>
            <option value="event">Event</option>
            <option value="advertisement">Advertisement</option>
            <option value="other">Other</option>
          </select>
          <select value={enquiry.programmeId}
                  onChange={(e) => setEnquiry((f) => ({ ...f, programmeId: e.target.value }))}>
            <option value="">Programme…</option>
            {programmes.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input type="text" placeholder="What they asked about" style={{ flex: 1 }}
                 value={enquiry.note}
                 onChange={(e) => setEnquiry((f) => ({ ...f, note: e.target.value }))} />
          <button disabled={busy || !enquiry.name || !enquiry.phone
                            || !enquiry.programmeId || !year || campuses.length === 0}
                  onClick={() => void act(() => apiPost('/v1/admissions/enquiries', {
                    name: enquiry.name, phone: enquiry.phone, source: enquiry.source,
                    campusId: campuses[0]!.id,
                    programmeId: enquiry.programmeId,
                    academicYearId: year!.id,
                    ...(enquiry.note ? { note: enquiry.note } : {}),
                  }), 'Enquiry recorded.')}>
            Record
          </button>
        </div>
      </Panel>

      <Panel title="Take an application"
             hint="The person, the answers and the application are one action — a form
                   that half-succeeds leaves two children who are one child">
        <div className="row-form">
          <input type="text" placeholder="Given name" value={intake.givenName}
                 onChange={(e) => setIntake((f) => ({ ...f, givenName: e.target.value }))} />
          <input type="text" placeholder="Family name" value={intake.familyName}
                 onChange={(e) => setIntake((f) => ({ ...f, familyName: e.target.value }))} />
          <input type="date" value={intake.dateOfBirth}
                 onChange={(e) => setIntake((f) => ({ ...f, dateOfBirth: e.target.value }))} />
          <select value={intake.programmeId}
                  onChange={(e) => setIntake((f) => ({ ...f, programmeId: e.target.value }))}>
            <option value="">Programme…</option>
            {programmes.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select value={intake.formDefinitionId}
                  onChange={(e) => {
                    setIntake((f) => ({ ...f, formDefinitionId: e.target.value }));
                    // Answers belong to the form that asked for them. Keeping
                    // them across a form change would submit one form's
                    // answers against another's schema.
                    setAnswers({});
                  }}>
            <option value="">Form…</option>
            {forms.map((f) => (
              <option key={f.id} value={f.id}>{f.title} (v{f.version})</option>
            ))}
          </select>
        </div>

        {chosenForm ? (
          <div className="row-form" style={{ marginTop: 10 }}>
            {fields.map((f) => (
              f.type === 'boolean' ? (
                <label key={f.key} className="sub">
                  <input type="checkbox" checked={Boolean(answers[f.key])}
                         onChange={(e) => setAnswers(
                           (a) => ({ ...a, [f.key]: e.target.checked }))} />
                  {f.label}{f.required ? ' *' : ''}
                </label>
              ) : f.options ? (
                <select key={f.key} value={String(answers[f.key] ?? '')}
                        onChange={(e) => setAnswers(
                          (a) => ({ ...a, [f.key]: e.target.value }))}>
                  <option value="">{f.label}{f.required ? ' *' : ''}…</option>
                  {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <input key={f.key}
                       type={f.type === 'string' ? 'text' : 'number'}
                       placeholder={`${f.label}${f.required ? ' *' : ''}`}
                       value={String(answers[f.key] ?? '')}
                       onChange={(e) => setAnswers(
                         (a) => ({ ...a, [f.key]: e.target.value }))} />
              )
            ))}
            {!renderable ? (
              <input type="text" style={{ flex: 1 }}
                     placeholder='The rest of this form, as JSON'
                     value={intake.answers}
                     onChange={(e) => setIntake((f) => ({ ...f, answers: e.target.value }))} />
            ) : null}
          </div>
        ) : null}

        <div className="row-form" style={{ marginTop: 10 }}>
          <button disabled={busy || !intake.givenName || !intake.programmeId
                            || !intake.formDefinitionId || !year
                            || fields.some((f) => f.required && !answers[f.key])}
                  onClick={() => void act(async () => {
                    // The schema's own types, not everything as a string: a
                    // number field posted as "9" fails validation against
                    // {"type":"number"} and the refusal reads like the
                    // applicant's fault.
                    const typed: Record<string, unknown> = {};
                    for (const f of fields) {
                      const v = answers[f.key];
                      if (v === undefined || v === '') continue;
                      typed[f.key] = f.type === 'boolean' ? Boolean(v)
                        : f.type === 'string' ? String(v)
                        : Number(v);
                    }
                    let extra: Record<string, unknown> = {};
                    if (!renderable) {
                      try { extra = JSON.parse(intake.answers) as Record<string, unknown>; }
                      catch { throw new Error('The extra answers are not valid JSON.'); }
                    }
                    return apiPost('/v1/admissions/applications', {
                      givenName: intake.givenName,
                      ...(intake.familyName ? { familyName: intake.familyName } : {}),
                      ...(intake.dateOfBirth ? { dateOfBirth: intake.dateOfBirth } : {}),
                      programmeId: intake.programmeId,
                      academicYearId: year!.id,
                      formDefinitionId: intake.formDefinitionId,
                      answers: { ...extra, ...typed },
                      ...(intake.enquiryId ? { enquiryId: intake.enquiryId } : {}),
                    });
                  }, 'Application taken.')}>
            Take it
          </button>
        </div>
        {intake.enquiryId ? (
          <p className="sub" style={{ marginTop: 8 }}>
            This will close the enquiry it came from, so nobody rings the family
            about applying after they have applied.
          </p>
        ) : null}
      </Panel>
    </Shell>
  );
}
