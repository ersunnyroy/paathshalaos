'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Shell } from '../../../shell';
import { Empty } from '@/components/ui';
import { ConfirmButton } from '@/components/confirm';
import { apiKey, useApiQuery } from '@/lib/query';
import { apiPost, loadBrand } from '@/lib/api';
import { localIsoDate } from '@/lib/dates';
import { guardianName, orderGuardians, type GuardianLink } from '@/lib/learner';
import { yearLabel } from '@/lib/structure';
import {
  KINDS, certificate, certificateFile, longDate, type CertificateKind,
} from '@/lib/certificate';
import { headerLines, signatory, type Letterhead } from '@/lib/letterhead';

interface Learner {
  id: string; admission_no: string; lifecycle_status: string;
  given_name: string; family_name: string | null; date_of_birth: string | null;
  section_name: string | null; class_name: string | null;
}
interface Year { id: string; label: string; starts_on: string; ends_on: string; status: string }
interface Issued {
  id: string; kind: CertificateKind; certificate_no: string; issued_on: string;
  purpose: string | null; title: string; paragraphs: string[]; issued_by_name: string | null;
}

/**
 * A certificate for one learner.
 *
 * What is on screen before issuing is a preview, worded in the browser from
 * the record. Issuing asks the server, which words it again from its own
 * copy of the record, gives it a number and keeps it on the register; what
 * prints is what the server kept. A certificate already issued can be opened
 * and printed again, and says exactly what it said the first time.
 *
 * Where the register is not available (a server that predates it), the page
 * falls back to printing an unnumbered copy and says that is what it is.
 */
export default function CertificatePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const client = useQueryClient();
  const [kind, setKind] = useState<CertificateKind>('bonafide');
  const [purpose, setPurpose] = useState('');
  const [school, setSchool] = useState('');
  const [shown, setShown] = useState<Issued | null>(null);
  const [printId, setPrintId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const registerPath = `/v1/students/${id}/certificates`;
  const learner = useApiQuery<Learner>(`/v1/students/${id}`);
  const guardians = useApiQuery<GuardianLink[]>(`/v1/students/${id}/guardians`);
  const years = useApiQuery<Year[]>('/v1/structure/years');
  const letterhead = useApiQuery<Letterhead>('/v1/branding/letterhead', { retry: false });
  const register = useApiQuery<Issued[]>(registerPath, { retry: false });
  const today = localIsoDate();

  useEffect(() => {
    void loadBrand().then((brand) => setSchool(brand?.name ?? '')).catch(() => setSchool(''));
  }, []);

  const l = learner.data;
  const primary = guardians.data ? orderGuardians(guardians.data)[0] : undefined;
  const year = years.data?.find((y) => y.status === 'active');
  const preview = l && school ? certificate({
    kind,
    learnerName: [l.given_name, l.family_name].filter(Boolean).join(' '),
    admissionNo: l.admission_no, className: l.class_name, sectionName: l.section_name,
    dateOfBirth: l.date_of_birth,
    guardianName: primary ? guardianName(primary) : null,
    yearLabel: year ? (year.label || yearLabel(year.starts_on, year.ends_on)) : null,
    schoolName: school, purpose, issuedOn: today,
    enrolled: l.lifecycle_status === 'enrolled',
  }) : null;

  const lines = headerLines(letterhead.data);
  const signs = signatory(letterhead.data, 'Principal / Head of school');
  const hasRegister = !register.isError;
  const paper = shown
    ? { title: shown.title, paragraphs: shown.paragraphs, number: shown.certificate_no, on: shown.issued_on }
    : preview && preview.problems.length === 0
      ? { title: preview.title, paragraphs: preview.paragraphs, number: null, on: today }
      : null;

  function print(fileKind: CertificateKind) {
    if (!l) return;
    // The browser offers the page title as the PDF's file name.
    const before = document.title;
    document.title = certificateFile(fileKind, l.admission_no, shown?.issued_on ?? today);
    window.print();
    document.title = before;
  }

  // Printed only once the issued certificate is what is on the page.
  useEffect(() => {
    if (!printId || shown?.id !== printId) return;
    setPrintId(null);
    print(shown.kind);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printId, shown]);

  async function issue() {
    setError(null);
    try {
      const out = await apiPost<Issued>(registerPath, { kind, purpose });
      setShown(out);
      setPrintId(out.id);
      await client.invalidateQueries({ queryKey: apiKey(registerPath) });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Shell>
      <div className="receipt-tools no-print">
        <button type="button" className="ghost" onClick={() => router.back()}>← Back</button>
        {shown ? (
          <div className="row">
            <button type="button" onClick={() => setShown(null)}>Issue another</button>
            <button type="button" className="primary" onClick={() => print(shown.kind)}>
              Print {shown.certificate_no} again
            </button>
          </div>
        ) : (
          <div className="row">
            <select value={kind} aria-label="Which certificate"
                    onChange={(e) => setKind(e.target.value as CertificateKind)}>
              {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
            <input type="text" value={purpose} maxLength={120} style={{ minWidth: 240 }}
                   placeholder="What is it for? (optional)" aria-label="What it is for"
                   onChange={(e) => setPurpose(e.target.value)} />
            {hasRegister ? (
              <ConfirmButton label="Issue and print" confirmLabel="Issue it? It gets a number."
                             disabled={!preview || preview.problems.length > 0 || register.isPending}
                             onConfirm={issue} />
            ) : (
              <button type="button" className="primary"
                      disabled={!preview || preview.problems.length > 0}
                      onClick={() => print(kind)}>
                Print an unnumbered copy
              </button>
            )}
          </div>
        )}
      </div>

      {learner.isError ? (
        <Empty title="This learner is not available">
          They may have left, or they are not in a class you can see.
        </Empty>
      ) : null}
      {error ? <div className="note bad no-print" role="alert">{error}</div> : null}
      {!hasRegister ? (
        <div className="note no-print">
          The register of certificates is not available on this server yet, so this copy
          carries no number and is not recorded.
        </div>
      ) : null}
      {!shown && preview && preview.problems.length > 0 ? (
        <div className="note bad no-print">{preview.problems.join(' ')}</div>
      ) : null}
      {!shown && paper && hasRegister ? (
        <p className="sub no-print" style={{ margin: '0 0 10px' }}>
          Preview. It is numbered and recorded when you issue it.
        </p>
      ) : null}
      {!paper && !learner.isError && !(preview && preview.problems.length > 0)
        ? <p className="sub">Loading…</p> : null}

      {paper ? (
        <article className="receipt certificate">
          <header>
            <div>
              <h1>{school}</h1>
              {lines.length > 0 ? (
                <p className="lines">{lines.map((line) => <span key={line}>{line}</span>)}</p>
              ) : null}
            </div>
            <div className="kind"><strong>{paper.title}</strong></div>
          </header>
          <p className="dated">
            {paper.number ? <span className="number">No. {paper.number}</span> : null}
            <span>Date: {longDate(paper.on)}</span>
          </p>
          {paper.paragraphs.map((text, i) => <p key={i} className="body">{text}</p>)}
          <footer>
            <span>Issued from the school's records on {longDate(paper.on)}.</span>
            <span className="sign">
              {signs.map((line) => <span key={line} style={{ display: 'block' }}>{line}</span>)}
              {school}
            </span>
          </footer>
        </article>
      ) : null}

      {hasRegister && register.data && register.data.length > 0 ? (
        <section className="panel no-print" style={{ marginTop: 18 }}>
          <header><div><h2>Already issued</h2>
            <span className="hint">Open one to print it again, word for word</span></div></header>
          <table>
            <thead><tr><th>Number</th><th>Certificate</th><th>Issued</th><th>By</th><th>For</th></tr></thead>
            <tbody>
              {register.data.map((c) => (
                <tr key={c.id} className={`clickable${shown?.id === c.id ? ' on' : ''}`} tabIndex={0}
                    onClick={() => setShown(c)}
                    onKeyDown={(e) => { if (e.key === 'Enter') setShown(c); }}>
                  <td><strong>{c.certificate_no}</strong></td>
                  <td>{c.title}</td>
                  <td>{longDate(c.issued_on)}</td>
                  <td>{c.issued_by_name ?? '—'}</td>
                  <td>{c.purpose ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </Shell>
  );
}
