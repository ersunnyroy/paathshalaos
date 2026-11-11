'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Shell } from '../../../shell';
import { Empty } from '@/components/ui';
import { useApiQuery } from '@/lib/query';
import { loadBrand } from '@/lib/api';
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

/**
 * A certificate for one learner, worded from their record and printed.
 *
 * Nothing is typed onto it except what it is for. There is no register of
 * certificates issued yet, so this page does not number them: a number that is
 * not written down anywhere is worse than no number.
 */
export default function CertificatePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [kind, setKind] = useState<CertificateKind>('bonafide');
  const [purpose, setPurpose] = useState('');
  const [school, setSchool] = useState('');
  const learner = useApiQuery<Learner>(`/v1/students/${id}`);
  const guardians = useApiQuery<GuardianLink[]>(`/v1/students/${id}/guardians`);
  const years = useApiQuery<Year[]>('/v1/structure/years');
  const letterhead = useApiQuery<Letterhead>('/v1/branding/letterhead', { retry: false });
  const lines = headerLines(letterhead.data);
  const signs = signatory(letterhead.data, 'Principal / Head of school');
  const today = localIsoDate();

  useEffect(() => {
    void loadBrand().then((brand) => setSchool(brand?.name ?? '')).catch(() => setSchool(''));
  }, []);

  const l = learner.data;
  const primary = guardians.data ? orderGuardians(guardians.data)[0] : undefined;
  const year = years.data?.find((y) => y.status === 'active');
  const doc = l && school ? certificate({
    kind,
    learnerName: [l.given_name, l.family_name].filter(Boolean).join(' '),
    admissionNo: l.admission_no, className: l.class_name, sectionName: l.section_name,
    dateOfBirth: l.date_of_birth,
    guardianName: primary ? guardianName(primary) : null,
    yearLabel: year ? (year.label || yearLabel(year.starts_on, year.ends_on)) : null,
    schoolName: school, purpose, issuedOn: today,
    enrolled: l.lifecycle_status === 'enrolled',
  }) : null;

  function print() {
    if (!l) return;
    // The browser offers the page title as the PDF's file name.
    const before = document.title;
    document.title = certificateFile(kind, l.admission_no, today);
    window.print();
    document.title = before;
  }

  return (
    <Shell>
      <div className="receipt-tools no-print">
        <button type="button" className="ghost" onClick={() => router.back()}>← Back</button>
        <div className="row">
          <select value={kind} aria-label="Which certificate"
                  onChange={(e) => setKind(e.target.value as CertificateKind)}>
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
          <input type="text" value={purpose} maxLength={120} style={{ minWidth: 240 }}
                 placeholder="What is it for? (optional)" aria-label="What it is for"
                 onChange={(e) => setPurpose(e.target.value)} />
          <button type="button" className="primary"
                  disabled={!doc || doc.problems.length > 0} onClick={print}>
            Print or save as PDF
          </button>
        </div>
      </div>

      {learner.isError ? (
        <Empty title="This learner is not available">
          They may have left, or they are not in a class you can see.
        </Empty>
      ) : null}
      {doc && doc.problems.length > 0 ? (
        <div className="note bad no-print">{doc.problems.join(' ')}</div>
      ) : null}
      {!doc && !learner.isError ? <p className="sub">Loading…</p> : null}

      {doc && doc.problems.length === 0 ? (
        <article className="receipt certificate">
          <header>
            <div>
              <h1>{school}</h1>
              {lines.length > 0 ? (
                <p className="lines">{lines.map((line) => <span key={line}>{line}</span>)}</p>
              ) : null}
            </div>
            <div className="kind"><strong>{doc.title}</strong></div>
          </header>
          <p className="dated">Date: {longDate(today)}</p>
          {doc.paragraphs.map((text, i) => <p key={i} className="body">{text}</p>)}
          <footer>
            <span>Issued from the school's records on {longDate(today)}.</span>
            <span className="sign">
              {signs.map((line) => <span key={line} style={{ display: 'block' }}>{line}</span>)}
              {school}
            </span>
          </footer>
        </article>
      ) : null}
    </Shell>
  );
}
