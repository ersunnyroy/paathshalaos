'use client';

import { useEffect, useState } from 'react';
import { Shell, PageHead } from '../shell';
import { Panel, Pill, SkeletonRows, Empty, Icon } from '@/components/ui';
import { apiGet, apiPost } from '@/lib/api';

interface Counts { total?: number; valid?: number; invalid?: number; created?: number; updated?: number; skipped?: number }
interface Batch {
  id: string; entity: string; status: string;
  original_filename: string | null; created_at: string;
  preview_counts: Counts | null; applied_counts: Counts | null;
}

const STATUS_TONE: Record<string, 'good' | 'warning' | 'critical' | undefined> = {
  uploaded: 'warning', mapped: 'warning', validated: 'warning', previewed: 'warning',
  applied: 'good', reversed: 'critical', failed: 'critical',
};

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

/** "12 valid · 3 invalid", from whichever keys a batch actually carries. */
function describe(counts: Counts | null): string {
  if (!counts) return '—';
  const parts = Object.entries(counts)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => `${v} ${k}`);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

/** The target fields each kind of import understands. */
const TARGETS: Record<string, string[]> = {
  learner_roster: ['given_name', 'family_name', 'admission_no', 'date_of_birth',
                   'section_name', 'roll_no'],
  staff_roster: ['given_name', 'family_name', 'employee_code', 'designation',
                 'joined_on'],
  guardian_link: ['admission_no', 'guardian_name', 'guardian_phone', 'relationship'],
  fee_assignment: ['admission_no', 'fee_plan_name', 'effective_from'],
};

export default function ImportsPage() {
  const [rows, setRows] = useState<Batch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  const [entity, setEntity] = useState('learner_roster');
  const [csv, setCsv] = useState('');
  /** Set once a file is staged: the columns the file actually has. */
  const [staged, setStaged] = useState<{ batchId: string; columns: string[] } | null>(null);
  const [map, setMap] = useState<Record<string, string>>({});
  const [step, setStep] = useState<string | null>(null);

  useEffect(() => {
    apiGet<Batch[]>('/v1/imports').then(setRows).catch((e: Error) => setError(e.message));
  }, [reload]);

  async function act<T>(fn: () => Promise<T>, done: string): Promise<T | undefined> {
    setBusy(true); setError(null); setSaid(null);
    try {
      const out = await fn();
      setSaid(done);
      setReload((n) => n + 1);
      return out;
    } catch (e) { setError((e as Error).message); return undefined; }
    finally { setBusy(false); }
  }

  return (
    <Shell>
      <PageHead
        title="Imports"
        lede="Upload, map, validate, preview, apply — and reverse. Nothing is written to your records during validation, so a preview is safe to run on anything."
      />

      {error ? <div className="note bad">{error}</div> : null}
      {said ? <div className="note ok">{said}</div> : null}
      {step ? <div className="note">{step}</div> : null}

      <Panel title="Run an import"
             hint="Five steps, in order. The preview is the only moment somebody
                   sees what is about to happen to four hundred records">
        <div className="row-form">
          <select value={entity} disabled={staged !== null}
                  onChange={(e) => setEntity(e.target.value)}>
            <option value="learner_roster">Learners</option>
            <option value="staff_roster">Staff</option>
            <option value="guardian_link">Guardians</option>
            <option value="fee_assignment">Fee assignments</option>
          </select>
          <input type="file" accept=".csv,text/csv" disabled={busy || staged !== null}
                 onChange={(e) => {
                   const file = e.target.files?.[0];
                   if (!file) return;
                   // Read in the browser and post as text. The API takes the
                   // file's content, not a multipart upload, because the
                   // parsing belongs on the server and the transport does not
                   // need to be special to get it there.
                   void file.text().then(setCsv);
                 }} />
          <button disabled={busy || !csv || staged !== null}
                  onClick={() => void act(async () => {
                    const out = await apiPost<{ batchId: string; staged: number;
                                                columns: string[] }>('/v1/imports', {
                      entity, csv,
                    });
                    setStaged({ batchId: out.batchId, columns: out.columns });
                    setStep(`${out.staged} rows staged. Now say which column is which.`);
                    return out;
                  }, 'File staged.')}>
            Upload
          </button>
          {staged ? (
            <button className="ghost" disabled={busy}
                    onClick={() => { setStaged(null); setMap({}); setCsv(''); setStep(null); }}>
              Start again
            </button>
          ) : null}
        </div>

        {staged ? (
          <>
            <table style={{ marginTop: 12 }}>
              <thead><tr><th>Column in your file</th><th>Goes to</th></tr></thead>
              <tbody>
                {staged.columns.map((col) => (
                  <tr key={col}>
                    <td><strong>{col}</strong></td>
                    <td>
                      <select value={map[col] ?? ''}
                              onChange={(e) => setMap((m) => ({ ...m, [col]: e.target.value }))}>
                        <option value="">Ignore this column</option>
                        {(TARGETS[entity] ?? []).map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="row-form" style={{ marginTop: 12 }}>
              <button disabled={busy || Object.values(map).every((v) => !v)}
                      onClick={() => void act(async () => {
                        await apiPost(`/v1/imports/${staged.batchId}/mapping`, {
                          mappings: Object.entries(map)
                            .filter(([, target]) => target)
                            .map(([sourceColumn, targetField]) => ({
                              sourceColumn, targetField, transform: 'trim',
                            })),
                        });
                        const v = await apiPost<{ valid: number; invalid: number;
                                                  duplicate: number }>(
                          `/v1/imports/${staged.batchId}/validate`);
                        setStep(`${v.valid} rows valid, ${v.invalid} not, `
                          + `${v.duplicate} already here. Preview before applying.`);
                        return v;
                      }, 'Mapped and validated.')}>
                Map and validate
              </button>
              <button disabled={busy}
                      onClick={() => void act(async () => {
                        const pv = await apiPost<{ counts: Record<string, number>;
                                                   digest: string }>(
                          `/v1/imports/${staged.batchId}/preview`);
                        setStep(`Preview: ${Object.entries(pv.counts)
                          .map(([k, v]) => `${v} ${k}`).join(' · ')}.`);
                        return pv;
                      }, 'Previewed.')}>
                Preview
              </button>
              <button disabled={busy}
                      onClick={() => void act(async () => {
                        const ap = await apiPost<{ created: number; updated: number }>(
                          `/v1/imports/${staged.batchId}/apply`);
                        setStep(`Applied: ${ap.created} created, ${ap.updated} updated. `
                          + 'This can be reversed from the list below.');
                        setStaged(null); setMap({}); setCsv('');
                        return ap;
                      }, 'Applied.')}>
                Apply
              </button>
            </div>
          </>
        ) : null}
      </Panel>

      <Panel
        title="Batches"
        hint="The preview and the apply are built by the same code, so they cannot disagree"
      >
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th className="opt">Records</th>
                <th>Status</th>
                <th className="opt">Preview said</th>
                <th className="opt">Apply did</th>
                <th className="n opt">When</th>
                <th />
              </tr>
            </thead>
            {rows ? (
              <tbody>
                {rows.map((b) => (
                  <tr key={b.id}>
                    <td>{b.original_filename ?? <span className="muted">unnamed</span>}</td>
                    <td className="opt muted">{b.entity}</td>
                    <td><Pill tone={STATUS_TONE[b.status]}>{b.status}</Pill></td>
                    <td className="opt sub">{describe(b.preview_counts)}</td>
                    {/* Side by side on purpose: these two matching is the whole
                        acceptance criterion for a large import. */}
                    <td className="opt sub">{describe(b.applied_counts)}</td>
                    <td className="n opt muted">{when(b.created_at)}</td>
                    <td className="n">
                      {b.status === 'applied' ? (
                        // The feature that makes an import safe to attempt at
                        // all: a school that cannot take a bad one back will
                        // not run a good one either.
                        <button className="ghost" disabled={busy}
                                onClick={() => {
                                  const reason = window.prompt(
                                    'Why is this being reversed?');
                                  if (!reason) return;
                                  void act(() => apiPost(
                                    `/v1/imports/${b.id}/reverse`, { reason }),
                                    'Reversed.');
                                }}>
                          Reverse
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            ) : <SkeletonRows rows={3} cols={7} />}
          </table>
        </div>
        {rows?.length === 0 ? (
          <Empty title="No imports yet">
            Bring last year&rsquo;s register in as a spreadsheet rather than
            typing it. You will see exactly what would change before anything does.
          </Empty>
        ) : null}
        <div className="caption">
          <Icon.check />
          An applied batch can be reversed. The reversal removes what the import
          created and leaves what somebody has edited since.
        </div>
      </Panel>
    </Shell>
  );
}
