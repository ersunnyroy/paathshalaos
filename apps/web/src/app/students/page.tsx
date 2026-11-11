'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Shell, PageHead } from '../shell';
import { Empty, Avatar, Pill, Icon } from '@/components/ui';
import { DataTable } from '@/components/data-table';
import { useApiQuery } from '@/lib/query';

interface Student {
  id: string; admission_no: string;
  given_name: string; family_name: string | null;
  section_name: string | null; class_name: string | null;
}

const fullName = (s: Student) => [s.given_name, s.family_name].filter(Boolean).join(' ');

export default function StudentsPage() {
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');

  useEffect(() => {
    // The command palette links here as /students?q=<admission no>. Read once
    // on arrival; after that the box is the source of truth.
    const fromUrl = new URLSearchParams(window.location.search).get('q') ?? '';
    if (fromUrl) { setQ(fromUrl); setTerm(fromUrl); }
  }, []);

  useEffect(() => {
    // Debounced: a keystroke per request turns a search box into a load test.
    const handle = setTimeout(() => setTerm(q.trim()), 220);
    return () => clearTimeout(handle);
  }, [q]);

  const roster = useApiQuery<Student[]>(
    `/v1/students${term ? `?q=${encodeURIComponent(term)}` : ''}`,
    // Keep the last roster on screen while the next search loads, rather than
    // flashing a skeleton between every keystroke.
    { placeholderData: (previous) => previous });
  const students = roster.data ?? null;
  const error = roster.error?.message ?? null;

  return (
    <Shell>
      <PageHead
        title="Learners"
        lede="A guardian signing in sees their own children, from this same endpoint. The database decides, not this page."
      >
        <label className="search">
          <Icon.search />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name or admission number"
            aria-label="Search learners"
          />
        </label>
      </PageHead>

      {error ? <div className="note bad">{error}</div> : null}

      <DataTable<Student>
        id="learners"
        title="Roster"
        rows={students}
        rowKey={(s) => s.id}
        truncatedAt={200}
        empty={(
          <Empty title={q ? 'Nothing matches that search' : 'No learners yet'}>
            {q ? 'Try an admission number, or part of a name.' : 'Import a roster to get started.'}
          </Empty>
        )}
        columns={[
          {
            key: 'name', label: 'Learner', required: true, text: fullName,
            render: (s) => (
              <span className="who2">
                <Avatar name={fullName(s)} />
                <span>
                  <Link className="nm" href={`/students/${s.id}`}>{fullName(s)}</Link>
                  <span className="sub" style={{ display: 'block' }}>{s.admission_no}</span>
                </span>
              </span>
            ),
          },
          { key: 'admission_no', label: 'Admission no.', text: (s) => s.admission_no },
          {
            key: 'class', label: 'Class', text: (s) => s.class_name ?? '',
            render: (s) => (s.class_name
              ? <Pill>{s.class_name}</Pill> : <span className="sub">Not enrolled</span>),
          },
          { key: 'section', label: 'Section', text: (s) => s.section_name ?? '' },
        ]}
      />
    </Shell>
  );
}
