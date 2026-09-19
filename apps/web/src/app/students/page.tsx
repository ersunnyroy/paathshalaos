'use client';

import { useEffect, useState } from 'react';
import { Shell, PageHead } from '../shell';
import { Panel, Empty, SkeletonRows, Avatar, Pill, Icon } from '@/components/ui';
import { apiGet } from '@/lib/api';

interface Student {
  id: string; admission_no: string;
  given_name: string; family_name: string | null;
  section_name: string | null; class_name: string | null;
}

export default function StudentsPage() {
  const [students, setStudents] = useState<Student[] | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Debounced: a keystroke per request turns a search box into a load test.
    const handle = setTimeout(() => {
      apiGet<Student[]>(`/v1/students${q ? `?q=${encodeURIComponent(q)}` : ''}`)
        .then(setStudents)
        .catch((e: Error) => setError(e.message));
    }, 220);
    return () => clearTimeout(handle);
  }, [q]);

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

      <Panel
        title="Roster"
        hint={students ? `${students.length} shown` : undefined}
      >
        {students && students.length === 0 ? (
          <Empty title={q ? 'Nothing matches that search' : 'No learners yet'}>
            {q ? 'Try an admission number, or part of a name.' : 'Import a roster to get started.'}
          </Empty>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Learner</th>
                  <th className="opt">Admission no.</th>
                  <th>Class</th>
                </tr>
              </thead>
              {students ? (
                <tbody>
                  {students.map((s) => {
                    const name = [s.given_name, s.family_name].filter(Boolean).join(' ');
                    return (
                      <tr key={s.id}>
                        <td>
                          <span className="who2">
                            <Avatar name={name} />
                            <span>
                              <span className="nm">{name}</span>
                              <span className="sub" style={{ display: 'block' }}>
                                {s.admission_no}
                              </span>
                            </span>
                          </span>
                        </td>
                        <td className="opt">{s.admission_no}</td>
                        <td>
                          {s.class_name
                            ? <Pill>{`${s.class_name} ${s.section_name ?? ''}`.trim()}</Pill>
                            : <span className="sub">Not enrolled</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              ) : <SkeletonRows rows={8} cols={3} />}
            </table>
          </div>
        )}
      </Panel>
    </Shell>
  );
}
