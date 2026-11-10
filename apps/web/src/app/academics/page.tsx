'use client';

import { useState, type FormEvent, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Shell, PageHead } from '../shell';
import { Panel, Empty, Pill, SkeletonRows } from '@/components/ui';
import { apiPost, ApiError } from '@/lib/api';
import { useApiQuery, apiKey } from '@/lib/query';
import {
  yearLabel, suggestTerms, yearProblem, codeFrom, codeOk, capacityFrom, orderClasses,
  type TermDraft,
} from '@/lib/structure';

/**
 * The school's structure: years, classes, subjects, programmes, rooms (M41).
 *
 * M36 made all of this writable through the API after finding that a school
 * could not create an academic year at all. It still had no screen — the only
 * way to add Class XI was a seed script or a curl command. This is the screen.
 *
 * Nothing here deletes. A year with enrolments, or a subject with marks
 * against it, is history; the API has no delete for them and this page does
 * not pretend otherwise.
 */

interface Unit { id: string; campus_id: string; code: string; name: string }
interface Campus { id: string; code: string; name: string }
interface Year { id: string; academic_unit_id: string; label: string; starts_on: string; ends_on: string; status: string }
interface Term { id: string; label: string; sequence: number; starts_on: string; ends_on: string }
interface Programme { id: string; code: string; name: string; credential_type: string | null }
interface Subject { id: string; code: string; name: string; subject_type: string | null }
interface Room { id: string; code: string; name: string; capacity: number | null; room_type: string | null }
interface ClassGroup { id: string; programme_id: string; name: string; group_kind: string; level_sequence: number | null }
interface Section { id: string; name: string; capacity: number | null }

type Tab = 'years' | 'classes' | 'subjects' | 'programmes' | 'rooms';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'years', label: 'Years and terms' },
  { id: 'classes', label: 'Classes and sections' },
  { id: 'subjects', label: 'Subjects' },
  { id: 'programmes', label: 'Programmes' },
  { id: 'rooms', label: 'Rooms' },
];

const day = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { dateStyle: 'medium' });
const words = (value: string | null) => (value ?? '—').replace(/_/g, ' ');

export default function AcademicsPage() {
  const [tab, setTab] = useState<Tab>('years');
  const units = useApiQuery<Unit[]>('/v1/academic-units');
  const unit = units.data?.[0] ?? null;

  return (
    <Shell>
      <PageHead title="School structure"
                lede="Years, classes, subjects and rooms. Everything else in the product — admissions, timetables, fees, report cards — hangs off these." />

      <div className="console-tabs" role="tablist" aria-label="Structure sections">
        {TABS.map((t) => (
          <button key={t.id} role="tab" type="button" aria-selected={tab === t.id}
                  onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {units.isError ? <div className="note bad" style={{ marginTop: 16 }}>{units.error.message}</div> : null}
      {units.data && !unit ? (
        <Panel title="School structure"><Empty title="This school has no academic unit yet">
          One is created when a school is provisioned. Contact support.
        </Empty></Panel>
      ) : null}

      {unit && tab === 'years' ? <Years unit={unit} /> : null}
      {unit && tab === 'classes' ? <Classes unit={unit} /> : null}
      {unit && tab === 'subjects' ? <Subjects unit={unit} /> : null}
      {unit && tab === 'programmes' ? <Programmes unit={unit} /> : null}
      {unit && tab === 'rooms' ? <Rooms /> : null}
    </Shell>
  );
}

/* ---------------------------------------------------------------- shared */

function Sheet({ title, lede, onClose, onSubmit, busy, error, submitLabel, children, wide }: {
  title: string; lede?: string; onClose: () => void; onSubmit: (e: FormEvent) => void;
  busy: boolean; error: string | null; submitLabel: string; children: ReactNode; wide?: boolean;
}) {
  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <form className={`sheet${wide ? ' wide' : ''}`} onSubmit={onSubmit}
            onMouseDown={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {lede ? <p className="lede">{lede}</p> : null}
        {children}
        {error ? <div className="note bad" style={{ marginTop: 12 }}>{error}</div> : null}
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>
        </div>
      </form>
    </div>
  );
}

/** Posts, refreshes the lists it changed, and reports what the API said. */
function useSave(invalidate: string[]) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(path: string, body: unknown): Promise<boolean> {
    setBusy(true); setError(null);
    try {
      await apiPost(path, body);
      await Promise.all(invalidate.map((p) => client.invalidateQueries({ queryKey: apiKey(p) })));
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not save.');
      return false;
    } finally { setBusy(false); }
  }
  return { busy, error, setError, save };
}

/* ----------------------------------------------------------------- years */

function Years({ unit }: { unit: Unit }) {
  const years = useApiQuery<Year[]>('/v1/structure/years');
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const activate = useSave(['/v1/structure/years']);

  return (
    <Panel title="Academic years" hint="One year is active at a time. Activating a new year does not move anybody: promotion is a separate, deliberate step."
           actions={<button className="primary" onClick={() => setAdding(true)}>Add year</button>}>
      {activate.error ? <div className="note bad" style={{ margin: '0 16px 12px' }}>{activate.error}</div> : null}
      <div className="scroll"><table>
        <thead><tr><th>Year</th><th>Runs</th><th>Status</th><th /></tr></thead>
        {!years.data ? <SkeletonRows cols={4} rows={2} /> : years.data.length === 0 ? (
          <tbody><tr><td colSpan={4}><Empty title="No academic year yet">Add the first one to begin.</Empty></td></tr></tbody>
        ) : (
          <tbody>
            {years.data.map((y) => (
              <YearRow key={y.id} year={y} open={open === y.id}
                       onToggle={() => setOpen(open === y.id ? null : y.id)}
                       onActivate={() => activate.save(`/v1/structure/years/${y.id}/activate`, {})}
                       busy={activate.busy} />
            ))}
          </tbody>
        )}
      </table></div>
      {adding ? <AddYear unit={unit} onClose={() => setAdding(false)} /> : null}
    </Panel>
  );
}

function YearRow({ year, open, onToggle, onActivate, busy }: {
  year: Year; open: boolean; onToggle: () => void; onActivate: () => void; busy: boolean;
}) {
  const terms = useApiQuery<Term[]>(open ? `/v1/structure/years/${year.id}/terms` : null);
  return (
    <>
      <tr>
        <td><strong>{year.label}</strong></td>
        <td>{day(year.starts_on)} to {day(year.ends_on)}</td>
        <td><Pill tone={year.status === 'active' ? 'good' : undefined}>{words(year.status)}</Pill></td>
        <td className="num">
          <span className="row" style={{ justifyContent: 'flex-end' }}>
            <button onClick={onToggle}>{open ? 'Hide terms' : 'Terms'}</button>
            {year.status !== 'active'
              ? <button onClick={onActivate} disabled={busy}>Make active</button> : null}
          </span>
        </td>
      </tr>
      {open ? (
        <tr className="nested"><td colSpan={4}>
          {!terms.data ? <span className="sub">Loading…</span>
            : terms.data.length === 0 ? <span className="sub">No terms in this year.</span>
            : (
              <span className="chips">
                {terms.data.map((t) => (
                  <span className="chip" key={t.id}>
                    <strong>{t.label}</strong>&nbsp;{day(t.starts_on)} to {day(t.ends_on)}
                  </span>
                ))}
              </span>
            )}
        </td></tr>
      ) : null}
    </>
  );
}

function AddYear({ unit, onClose }: { unit: Unit; onClose: () => void }) {
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [label, setLabel] = useState('');
  const [labelTouched, setLabelTouched] = useState(false);
  const [terms, setTerms] = useState<TermDraft[]>([]);
  const { busy, error, setError, save } = useSave(['/v1/structure/years']);

  const shownLabel = labelTouched ? label : yearLabel(startsOn, endsOn);

  function term(index: number, field: keyof TermDraft, value: string) {
    setTerms(terms.map((t, i) => (i === index ? { ...t, [field]: value } : t)));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = yearProblem({ label: shownLabel, startsOn, endsOn, terms });
    if (problem) { setError(problem); return; }
    const ok = await save('/v1/structure/years', {
      academicUnitId: unit.id, label: shownLabel.trim(), startsOn, endsOn,
      ...(terms.length > 0 ? { terms } : {}),
    });
    if (ok) onClose();
  }

  return (
    <Sheet title="Add an academic year" wide onClose={onClose} onSubmit={submit} busy={busy} error={error}
           submitLabel="Add year" lede="It is added as a draft. Make it active when the school moves into it.">
      <div className="grid2">
        <div>
          <label htmlFor="year-start">Starts</label>
          <input id="year-start" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} required />
        </div>
        <div>
          <label htmlFor="year-end">Ends</label>
          <input id="year-end" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} required />
        </div>
      </div>
      <label htmlFor="year-label">Label</label>
      <input id="year-label" type="text" value={shownLabel} placeholder="2027-28"
             onChange={(e) => { setLabel(e.target.value); setLabelTouched(true); }} required />

      <label>Terms</label>
      <div className="row" style={{ marginBottom: 8 }}>
        {[1, 2, 3].map((n) => (
          <button type="button" key={n} disabled={!startsOn || !endsOn}
                  onClick={() => setTerms(suggestTerms(startsOn, endsOn, n))}>
            {n === 1 ? 'One term' : `${n} equal terms`}
          </button>
        ))}
        {terms.length > 0 ? <button type="button" className="ghost" onClick={() => setTerms([])}>No terms</button> : null}
      </div>
      {terms.length > 0 ? (
        <table className="mini">
          <thead><tr><th>Name</th><th>Starts</th><th>Ends</th></tr></thead>
          <tbody>
            {terms.map((t, i) => (
              <tr key={t.sequence}>
                <td><input type="text" value={t.label} aria-label={`Term ${i + 1} name`}
                           onChange={(e) => term(i, 'label', e.target.value)} /></td>
                <td><input type="date" value={t.startsOn} aria-label={`Term ${i + 1} starts`}
                           onChange={(e) => term(i, 'startsOn', e.target.value)} /></td>
                <td><input type="date" value={t.endsOn} aria-label={`Term ${i + 1} ends`}
                           onChange={(e) => term(i, 'endsOn', e.target.value)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <span className="sub">Pick the dates, then choose how many terms. You can adjust each one.</span>}
    </Sheet>
  );
}

/* --------------------------------------------------------------- classes */

function Classes({ unit }: { unit: Unit }) {
  const years = useApiQuery<Year[]>('/v1/structure/years');
  const [picked, setPicked] = useState('');
  // The active year unless somebody chose another: that is the one being run.
  const yearId = picked || years.data?.find((y) => y.status === 'active')?.id || years.data?.[0]?.id || '';
  const path = yearId ? `/v1/structure/class-groups?academicYearId=${yearId}` : null;
  const groups = useApiQuery<ClassGroup[]>(path);
  const programmes = useApiQuery<Programme[]>('/v1/structure/programmes');
  const [adding, setAdding] = useState(false);
  const [sectionFor, setSectionFor] = useState<ClassGroup | null>(null);
  void unit;

  return (
    <Panel title="Classes and sections" hint="A class belongs to one year. Next year's Class IX is a new class, so this year's reports never change."
           actions={(<>
             <select value={yearId} onChange={(e) => setPicked(e.target.value)} aria-label="Academic year">
               {(years.data ?? []).map((y) => <option key={y.id} value={y.id}>{y.label}</option>)}
             </select>
             <button className="primary" disabled={!yearId} onClick={() => setAdding(true)}>Add class</button>
           </>)}>
      <div className="scroll"><table>
        <thead><tr><th>Class</th><th className="opt">Kind</th><th>Sections</th><th /></tr></thead>
        {!groups.data ? <SkeletonRows cols={4} rows={3} /> : groups.data.length === 0 ? (
          <tbody><tr><td colSpan={4}><Empty title="No classes in this year yet" /></td></tr></tbody>
        ) : (
          <tbody>
            {orderClasses(groups.data).map((g) => (
              <ClassRow key={g.id} group={g} onAddSection={() => setSectionFor(g)} />
            ))}
          </tbody>
        )}
      </table></div>
      {adding && path ? (
        <AddClass yearId={yearId} programmes={programmes.data ?? []} listPath={path}
                  onClose={() => setAdding(false)} />
      ) : null}
      {sectionFor ? <AddSection group={sectionFor} onClose={() => setSectionFor(null)} /> : null}
    </Panel>
  );
}

function ClassRow({ group, onAddSection }: { group: ClassGroup; onAddSection: () => void }) {
  const sections = useApiQuery<Section[]>(`/v1/structure/class-groups/${group.id}/sections`);
  return (
    <tr>
      <td>
        <strong>{group.name}</strong>
        {group.level_sequence !== null
          ? <span className="sub" style={{ display: 'block' }}>Level {group.level_sequence}</span> : null}
      </td>
      <td className="opt">{words(group.group_kind)}</td>
      <td>
        {!sections.data ? <span className="sub">…</span>
          : sections.data.length === 0 ? <span className="sub">None yet</span>
          : (
            <span className="chips">
              {sections.data.map((s) => (
                <span className="chip" key={s.id} title={s.capacity ? `Capacity ${s.capacity}` : 'No capacity set'}>
                  {s.name}{s.capacity ? ` · ${s.capacity}` : ''}
                </span>
              ))}
            </span>
          )}
      </td>
      <td className="num"><button onClick={onAddSection}>Add section</button></td>
    </tr>
  );
}

function AddClass({ yearId, programmes, listPath, onClose }: {
  yearId: string; programmes: Programme[]; listPath: string; onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [programmeId, setProgrammeId] = useState(programmes[0]?.id ?? '');
  const [level, setLevel] = useState('');
  const { busy, error, setError, save } = useSave([listPath]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const levelText = level.trim();
    if (levelText !== '' && !/^\d{1,3}$/.test(levelText)) { setError('Level is a whole number, like 9 for Class IX.'); return; }
    if (!programmeId) { setError('Add a programme first, on the Programmes tab.'); return; }
    const ok = await save('/v1/structure/class-groups', {
      programmeId, academicYearId: yearId, name: name.trim(),
      ...(levelText === '' ? {} : { levelSequence: Number(levelText) }),
    });
    if (ok) onClose();
  }

  return (
    <Sheet title="Add a class" onClose={onClose} onSubmit={submit} busy={busy} error={error} submitLabel="Add class">
      <label htmlFor="class-name">Name</label>
      <input id="class-name" type="text" value={name} placeholder="Class XI" required
             onChange={(e) => setName(e.target.value)} />
      <label htmlFor="class-programme">Programme</label>
      <select id="class-programme" value={programmeId} onChange={(e) => setProgrammeId(e.target.value)}>
        {programmes.length === 0 ? <option value="">No programme yet</option> : null}
        {programmes.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <label htmlFor="class-level">Level (optional) — sets the order, so renaming a class never reorders old reports</label>
      <input id="class-level" type="text" inputMode="numeric" value={level} placeholder="11"
             onChange={(e) => setLevel(e.target.value)} />
    </Sheet>
  );
}

function AddSection({ group, onClose }: { group: ClassGroup; onClose: () => void }) {
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState('');
  const { busy, error, setError, save } = useSave([`/v1/structure/class-groups/${group.id}/sections`, '/v1/sections']);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const cap = capacityFrom(capacity);
    if (cap === null) { setError('Capacity is a whole number between 1 and 10,000.'); return; }
    const ok = await save('/v1/structure/sections', {
      classGroupId: group.id, name: name.trim(), ...(cap === undefined ? {} : { capacity: cap }),
    });
    if (ok) onClose();
  }

  return (
    <Sheet title={`Add a section to ${group.name}`} onClose={onClose} onSubmit={submit}
           busy={busy} error={error} submitLabel="Add section">
      <label htmlFor="section-name">Name</label>
      <input id="section-name" type="text" value={name} placeholder="C" required
             onChange={(e) => setName(e.target.value)} />
      <label htmlFor="section-capacity">Capacity (optional)</label>
      <input id="section-capacity" type="text" inputMode="numeric" value={capacity} placeholder="40"
             onChange={(e) => setCapacity(e.target.value)} />
    </Sheet>
  );
}

/* ------------------------------------------- subjects, programmes, rooms */

/** A name and a code, where the code follows the name until somebody edits it. */
function NameAndCode({ name, setName, code, setCode, touched, setTouched, placeholder }: {
  name: string; setName: (v: string) => void; code: string; setCode: (v: string) => void;
  touched: boolean; setTouched: (v: boolean) => void; placeholder: string;
}) {
  return (
    <>
      <label htmlFor="item-name">Name</label>
      <input id="item-name" type="text" value={name} placeholder={placeholder} required
             onChange={(e) => { setName(e.target.value); if (!touched) setCode(codeFrom(e.target.value)); }} />
      <label htmlFor="item-code">Code — short, and it appears on timetables and reports</label>
      <input id="item-code" type="text" value={code} required
             onChange={(e) => { setCode(e.target.value); setTouched(true); }} />
    </>
  );
}

function Subjects({ unit }: { unit: Unit }) {
  const subjects = useApiQuery<Subject[]>('/v1/structure/subjects');
  const [adding, setAdding] = useState(false);
  return (
    <Panel title="Subjects" hint="What is taught. A subject is offered to a class in a term separately."
           actions={<button className="primary" onClick={() => setAdding(true)}>Add subject</button>}>
      <div className="scroll"><table>
        <thead><tr><th>Subject</th><th>Code</th><th>Type</th></tr></thead>
        {!subjects.data ? <SkeletonRows cols={3} rows={3} /> : subjects.data.length === 0 ? (
          <tbody><tr><td colSpan={3}><Empty title="No subjects yet" /></td></tr></tbody>
        ) : (
          <tbody>
            {subjects.data.map((s) => (
              <tr key={s.id}><td><strong>{s.name}</strong></td><td>{s.code}</td><td>{words(s.subject_type)}</td></tr>
            ))}
          </tbody>
        )}
      </table></div>
      {adding ? <AddSubject unit={unit} onClose={() => setAdding(false)} /> : null}
    </Panel>
  );
}

function AddSubject({ unit, onClose }: { unit: Unit; onClose: () => void }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [touched, setTouched] = useState(false);
  const [type, setType] = useState('core');
  const { busy, error, setError, save } = useSave(['/v1/structure/subjects']);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!codeOk(code.trim())) { setError('A code is letters, digits, spaces, hyphens and underscores, up to 32 characters.'); return; }
    const ok = await save('/v1/structure/subjects', {
      academicUnitId: unit.id, code: code.trim(), name: name.trim(), subjectType: type,
    });
    if (ok) onClose();
  }

  return (
    <Sheet title="Add a subject" onClose={onClose} onSubmit={submit} busy={busy} error={error} submitLabel="Add subject">
      <NameAndCode name={name} setName={setName} code={code} setCode={setCode}
                   touched={touched} setTouched={setTouched} placeholder="Physics" />
      <label htmlFor="subject-type">Type</label>
      <select id="subject-type" value={type} onChange={(e) => setType(e.target.value)}>
        <option value="core">Core</option>
        <option value="elective">Elective</option>
        <option value="language">Language</option>
        <option value="co_scholastic">Co-scholastic</option>
      </select>
    </Sheet>
  );
}

function Programmes({ unit }: { unit: Unit }) {
  const programmes = useApiQuery<Programme[]>('/v1/structure/programmes');
  const [adding, setAdding] = useState(false);
  return (
    <Panel title="Programmes" hint="The course of study a class follows: a board curriculum, a diploma, a coaching batch."
           actions={<button className="primary" onClick={() => setAdding(true)}>Add programme</button>}>
      <div className="scroll"><table>
        <thead><tr><th>Programme</th><th>Code</th><th>Leads to</th></tr></thead>
        {!programmes.data ? <SkeletonRows cols={3} rows={2} /> : programmes.data.length === 0 ? (
          <tbody><tr><td colSpan={3}><Empty title="No programmes yet" /></td></tr></tbody>
        ) : (
          <tbody>
            {programmes.data.map((p) => (
              <tr key={p.id}><td><strong>{p.name}</strong></td><td>{p.code}</td><td>{words(p.credential_type)}</td></tr>
            ))}
          </tbody>
        )}
      </table></div>
      {adding ? <AddProgramme unit={unit} onClose={() => setAdding(false)} /> : null}
    </Panel>
  );
}

function AddProgramme({ unit, onClose }: { unit: Unit; onClose: () => void }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [touched, setTouched] = useState(false);
  const [credential, setCredential] = useState('board_examination');
  const { busy, error, setError, save } = useSave(['/v1/structure/programmes']);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!codeOk(code.trim())) { setError('A code is letters, digits, spaces, hyphens and underscores, up to 32 characters.'); return; }
    const ok = await save('/v1/structure/programmes', {
      academicUnitId: unit.id, code: code.trim(), name: name.trim(), credentialType: credential,
    });
    if (ok) onClose();
  }

  return (
    <Sheet title="Add a programme" onClose={onClose} onSubmit={submit} busy={busy} error={error} submitLabel="Add programme">
      <NameAndCode name={name} setName={setName} code={code} setCode={setCode}
                   touched={touched} setTouched={setTouched} placeholder="CBSE Secondary" />
      <label htmlFor="programme-credential">Leads to</label>
      <select id="programme-credential" value={credential} onChange={(e) => setCredential(e.target.value)}>
        <option value="board_examination">Board examination</option>
        <option value="certificate">Certificate</option>
        <option value="diploma">Diploma</option>
        <option value="degree">Degree</option>
        <option value="none">Nothing formal</option>
      </select>
    </Sheet>
  );
}

function Rooms() {
  const rooms = useApiQuery<Room[]>('/v1/structure/rooms');
  const campuses = useApiQuery<Campus[]>('/v1/campuses');
  const [adding, setAdding] = useState(false);
  return (
    <Panel title="Rooms" hint="Where teaching happens. The timetable uses these to stop two classes being put in one room."
           actions={<button className="primary" onClick={() => setAdding(true)}>Add room</button>}>
      <div className="scroll"><table>
        <thead><tr><th>Room</th><th>Code</th><th>Type</th><th className="num">Capacity</th></tr></thead>
        {!rooms.data ? <SkeletonRows cols={4} rows={2} /> : rooms.data.length === 0 ? (
          <tbody><tr><td colSpan={4}><Empty title="No rooms yet">Add rooms before building a timetable.</Empty></td></tr></tbody>
        ) : (
          <tbody>
            {rooms.data.map((r) => (
              <tr key={r.id}>
                <td><strong>{r.name}</strong></td><td>{r.code}</td>
                <td>{words(r.room_type)}</td><td className="num">{r.capacity ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        )}
      </table></div>
      {adding ? <AddRoom campuses={campuses.data ?? []} onClose={() => setAdding(false)} /> : null}
    </Panel>
  );
}

function AddRoom({ campuses, onClose }: { campuses: Campus[]; onClose: () => void }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [touched, setTouched] = useState(false);
  const [campusId, setCampusId] = useState(campuses[0]?.id ?? '');
  const [type, setType] = useState('classroom');
  const [capacity, setCapacity] = useState('');
  const { busy, error, setError, save } = useSave(['/v1/structure/rooms']);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!codeOk(code.trim())) { setError('A code is letters, digits, spaces, hyphens and underscores, up to 32 characters.'); return; }
    const cap = capacityFrom(capacity);
    if (cap === null) { setError('Capacity is a whole number between 1 and 10,000.'); return; }
    if (!campusId) { setError('Choose a campus.'); return; }
    const ok = await save('/v1/structure/rooms', {
      campusId, code: code.trim(), name: name.trim(), roomType: type,
      ...(cap === undefined ? {} : { capacity: cap }),
    });
    if (ok) onClose();
  }

  return (
    <Sheet title="Add a room" onClose={onClose} onSubmit={submit} busy={busy} error={error} submitLabel="Add room">
      <NameAndCode name={name} setName={setName} code={code} setCode={setCode}
                   touched={touched} setTouched={setTouched} placeholder="Room 101" />
      {campuses.length > 1 ? (
        <>
          <label htmlFor="room-campus">Campus</label>
          <select id="room-campus" value={campusId} onChange={(e) => setCampusId(e.target.value)}>
            {campuses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </>
      ) : null}
      <label htmlFor="room-type">Type</label>
      <select id="room-type" value={type} onChange={(e) => setType(e.target.value)}>
        <option value="classroom">Classroom</option>
        <option value="laboratory">Laboratory</option>
        <option value="hall">Hall</option>
        <option value="library">Library</option>
        <option value="ground">Ground</option>
        <option value="other">Other</option>
      </select>
      <label htmlFor="room-capacity">Capacity (optional)</label>
      <input id="room-capacity" type="text" inputMode="numeric" value={capacity} placeholder="40"
             onChange={(e) => setCapacity(e.target.value)} />
    </Sheet>
  );
}
