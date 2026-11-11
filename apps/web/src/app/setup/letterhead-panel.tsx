'use client';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Panel } from '@/components/ui';
import { apiPost } from '@/lib/api';
import { apiKey, useApiQuery } from '@/lib/query';
import {
  LETTERHEAD_FIELDS, headerLines, letterheadProblems, missingForPaper, type Letterhead,
} from '@/lib/letterhead';

export const LETTERHEAD_PATH = '/v1/branding/letterhead';

type Form = Record<keyof Letterhead, string>;
const toForm = (lh: Letterhead | undefined): Form => Object.fromEntries(
  LETTERHEAD_FIELDS.map((f) => [f.key, lh?.[f.key] ?? ''])) as Form;

/**
 * What goes at the top of every receipt and certificate. One form, saved
 * whole: a field left blank is a line the school does not print.
 */
export function LetterheadPanel() {
  const saved = useApiQuery<Letterhead>(LETTERHEAD_PATH, { retry: false });
  const client = useQueryClient();
  const [form, setForm] = useState<Form>(() => toForm(undefined));
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  useEffect(() => { if (saved.data) setForm(toForm(saved.data)); }, [saved.data]);

  // A server that predates the letterhead has no such route. Say nothing
  // rather than show a form that cannot save.
  if (saved.isError) return null;

  const problems = letterheadProblems(form);
  const preview = headerLines(form);
  const missing = missingForPaper(form);

  async function save() {
    setBusy(true); setSaid(null);
    try {
      const out = await apiPost<Letterhead>(LETTERHEAD_PATH, form);
      client.setQueryData(apiKey(LETTERHEAD_PATH), out);
      setSaid({ tone: 'ok', text: 'Saved. Receipts and certificates printed from now on carry this.' });
    } catch (e) {
      setSaid({ tone: 'bad', text: (e as Error).message });
    } finally { setBusy(false); }
  }

  return (
    <Panel title="On the school's paper"
           hint="Printed at the top of every receipt and certificate"
           actions={
             <button type="button" className="primary"
                     disabled={busy || !saved.data || Object.keys(problems).length > 0}
                     onClick={() => void save()}>
               {busy ? 'Saving…' : 'Save'}
             </button>
           }>
      {said ? <div className={`note ${said.tone}`} role="status">{said.text}</div> : null}
      <div className="letterhead-form">
        {LETTERHEAD_FIELDS.map((f) => (
          <label key={f.key} className={f.wide ? 'wide' : undefined}>
            <span>{f.label}{f.hint ? <em> — {f.hint}</em> : null}</span>
            <input type="text" value={form[f.key]} maxLength={200}
                   aria-invalid={problems[f.key] ? true : undefined}
                   onChange={(e) => setForm((old) => ({ ...old, [f.key]: e.target.value }))} />
            {problems[f.key] ? <span className="sub bad" role="alert">{problems[f.key]}</span> : null}
          </label>
        ))}
      </div>
      <div className="letterhead-preview" aria-label="How the header will print">
        {preview.length > 0
          ? preview.map((line) => <span key={line}>{line}</span>)
          : <span className="sub">Nothing is printed under the school's name yet.</span>}
      </div>
      {missing.length > 0 ? (
        <p className="sub" style={{ padding: '0 16px 12px', margin: 0 }}>
          Still blank: {missing.join(', ')}. Banks and other schools usually look for these
          on a certificate.
        </p>
      ) : null}
    </Panel>
  );
}
