'use client';

import { useEffect, useState } from 'react';
import { Shell, PageHead } from '../shell';
import { Panel, Pill, SkeletonRows, Empty, Icon } from '@/components/ui';
import { apiGet } from '@/lib/api';

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

export default function ImportsPage() {
  const [rows, setRows] = useState<Batch[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<Batch[]>('/v1/imports').then(setRows).catch((e: Error) => setError(e.message));
  }, []);

  return (
    <Shell>
      <PageHead
        title="Imports"
        lede="Upload, map, validate, preview, apply — and reverse. Nothing is written to your records during validation, so a preview is safe to run on anything."
      />

      {error ? <div className="note bad">{error}</div> : null}

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
                  </tr>
                ))}
              </tbody>
            ) : <SkeletonRows rows={3} cols={6} />}
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
